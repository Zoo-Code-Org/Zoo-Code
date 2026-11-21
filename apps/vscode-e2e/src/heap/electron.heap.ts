import fs from "fs/promises"
import { closeSync, openSync, readFileSync, writeSync } from "fs"
import os from "os"
import path from "path"
import { LLMock } from "@copilotkit/aimock"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { _electron, expect, test, type CDPSession, type ElectronApplication, type Frame } from "@playwright/test"
import { createTranscript, LARGE_TASK_MARKER, SMALL_TASK_MARKER, type Workload } from "./workload"

const packageRoot = path.resolve(__dirname, "../..")
const results = process.env.HEAP_BENCHMARK_DIR ?? path.join(packageRoot, "heap-results")
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
	devDependencies: Record<string, string>
}

async function waitForFile(file: string): Promise<void> {
	await expect
		.poll(
			() =>
				fs.access(file).then(
					() => true,
					() => false,
				),
			{ timeout: 120_000 },
		)
		.toBe(true)
}

async function capture(client: CDPSession, file: string) {
	await client.send("HeapProfiler.collectGarbage")
	const usage = await client.send("Runtime.getHeapUsage")
	const descriptor = openSync(file, "w")
	const receive = ({ chunk }: { chunk: string }) => {
		writeSync(descriptor, chunk)
	}
	client.on("HeapProfiler.addHeapSnapshotChunk", receive)
	try {
		await client.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false })
	} finally {
		client.off("HeapProfiler.addHeapSnapshotChunk", receive)
		closeSync(descriptor)
	}
	return usage
}

for (const workload of ["repeated", "unique"] satisfies Workload[]) {
	test(`webview retained heap: ${workload} tool outputs`, async () => {
		const testInfo = test.info()
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-heap-"))
		const workspace = path.join(temporaryRoot, "workspace")
		const userData = path.join(temporaryRoot, "user-data")
		const extensions = path.join(temporaryRoot, "extensions")
		await Promise.all([workspace, userData, extensions].map((directory) => fs.mkdir(directory)))
		const mock = new LLMock({ port: 0 })
		for (const marker of [SMALL_TASK_MARKER, "HEAP_TRANSCRIPT_SEED"]) {
			mock.addFixture({
				match: { userMessage: marker },
				response: {
					toolCalls: [
						{
							name: "attempt_completion",
							arguments: JSON.stringify({ result: `${marker}_COMPLETED` }),
							id: `call_${marker}`,
						},
					],
				},
			})
		}
		let app: ElectronApplication | undefined
		let client: CDPSession | undefined
		try {
			await mock.start()
			const executablePath =
				process.env.HEAP_VSCODE_EXECUTABLE ??
				(await downloadAndUnzipVSCode({ version: packageJson.devDependencies["@types/vscode"] }))
			const launch = (phase: "seed" | "measure") =>
				_electron.launch({
					executablePath,
					args: [
						workspace,
						`--extensionDevelopmentPath=${path.join(results, "builds", testInfo.project.name, "src")}`,
						`--extensionTestsPath=${path.join(packageRoot, "out/heap/sceneController")}`,
						`--user-data-dir=${userData}`,
						`--extensions-dir=${extensions}`,
						"--disable-workspace-trust",
						"--skip-welcome",
						"--skip-release-notes",
						"--disable-updates",
						"--disable-gpu",
						"--force-device-scale-factor=1",
					],
					env: {
						...process.env,
						AIMOCK_URL: mock.url,
						HEAP_RUN_DIR: temporaryRoot,
						HEAP_WORKLOAD: workload,
						HEAP_PHASE: phase,
						HTTP_PROXY: "http://127.0.0.1:9",
						HTTPS_PROXY: "http://127.0.0.1:9",
						ALL_PROXY: "http://127.0.0.1:9",
						NO_PROXY: "127.0.0.1,localhost",
					},
					locale: "en-US",
					timezoneId: "UTC",
					timeout: 60_000,
				})

			app = await launch("seed")
			await waitForFile(path.join(temporaryRoot, "seed.ready"))
			await fs.writeFile(path.join(temporaryRoot, "seed.close"), "close")
			await app.close()
			app = undefined
			// No extension host is alive while replacing the persisted transcript.
			const seed = JSON.parse(await fs.readFile(path.join(temporaryRoot, "seed.ready"), "utf8")) as {
				largeTaskId: string
			}
			await fs.writeFile(
				path.join(temporaryRoot, "storage/tasks", seed.largeTaskId, "ui_messages.json"),
				JSON.stringify(createTranscript(workload)),
			)
			app = await launch("measure")
			const page = await app.firstWindow()
			await app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1200, height: 800 }),
			)
			await waitForFile(path.join(temporaryRoot, "empty.ready"))
			let content: Frame | undefined
			await expect
				.poll(() => {
					const parent = page
						.frames()
						.find((frame) => frame.url().includes("extensionId=ZooCodeOrganization.zoo-code"))
					content = parent?.childFrames().find((frame) => frame.url().includes("/fake.html"))
					return Boolean(content)
				})
				.toBe(true)
			if (!content) throw new Error("Zoo Code webview content frame not found")
			// The content iframe may share its CDP target with the outer webview.
			let targetFrame: Frame | null = content
			while (targetFrame) {
				try {
					client = await app.context().newCDPSession(targetFrame)
					break
				} catch (error) {
					if (!(error instanceof Error) || !error.message.includes("does not have a separate CDP session"))
						throw error
					targetFrame = targetFrame.parentFrame()
				}
			}
			if (!client) throw new Error("No CDP target found for the webview")
			await client.send("HeapProfiler.enable")
			const target = await client.send("Target.getTargetInfo")
			expect(target.targetInfo.url).toContain("vscode-webview")
			const stages: Record<string, unknown> = {}
			for (const stage of ["empty", "loaded", "switched"]) {
				await waitForFile(path.join(temporaryRoot, `${stage}.ready`))
				if (stage !== "empty") {
					await expect(
						content
							.getByText(stage === "loaded" ? LARGE_TASK_MARKER : `${SMALL_TASK_MARKER}_COMPLETED`, {
								exact: false,
							})
							.first(),
					).toBeVisible()
				}
				await content.evaluate(async () => {
					await document.fonts.ready
					await new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					)
				})
				stages[stage] = await capture(client, testInfo.outputPath(`${stage}.heapsnapshot`))
				await fs.writeFile(path.join(temporaryRoot, `${stage}.continue`), "continue")
			}
			await waitForFile(path.join(temporaryRoot, "done"))
			const measurement = {
				variant: testInfo.project.name,
				workload,
				repeat: testInfo.repeatEachIndex,
				vscode: packageJson.devDependencies["@types/vscode"],
				target,
				stages,
			}
			await fs.writeFile(testInfo.outputPath("measurement.json"), JSON.stringify(measurement, null, 2))
			await testInfo.attach("measurement", { body: JSON.stringify(measurement), contentType: "application/json" })
		} catch (error) {
			if (app)
				await (
					await app.firstWindow()
				)
					.screenshot({ path: testInfo.outputPath("failure.png") })
					.catch(() => undefined)
			await fs
				.cp(path.join(userData, "logs"), testInfo.outputPath("logs"), { recursive: true })
				.catch(() => undefined)
			throw error
		} finally {
			await fs.writeFile(path.join(temporaryRoot, "close"), "close").catch(() => undefined)
			await client?.detach().catch(() => undefined)
			await app?.close().catch(() => undefined)
			await mock.stop().catch(() => undefined)
			await fs.rm(temporaryRoot, { recursive: true, force: true })
		}
	})
}
