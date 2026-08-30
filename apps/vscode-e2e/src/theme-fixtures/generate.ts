import fs from "fs/promises"
import os from "os"
import path from "path"

import { runTests } from "@vscode/test-electron"
import type { WebviewThemeFixture } from "@roo-code/types"

import { themeFixtureDefinitions } from "./definitions"
import { createSerializedFixtures, findDriftedFixtures } from "./fixtures"

type GeneratorMode = "update" | "check"

async function readPinnedVSCodeVersion(packageRoot: string): Promise<string> {
	const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
		devDependencies?: Record<string, string>
	}
	const version = packageJson.devDependencies?.["@types/vscode"]
	if (!version) {
		throw new Error("apps/vscode-e2e/package.json does not pin @types/vscode")
	}
	return version
}

async function readTrackedFixtures(
	directory: string,
	fileNames: Iterable<string>,
): Promise<Map<string, string | undefined>> {
	return new Map(
		await Promise.all(
			[...fileNames].map(async (fileName) => {
				try {
					return [fileName, await fs.readFile(path.join(directory, fileName), "utf8")] as const
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						return [fileName, undefined] as const
					}
					throw error
				}
			}),
		),
	)
}

async function main(): Promise<void> {
	const mode = process.argv[2] as GeneratorMode | undefined
	if (mode !== "update" && mode !== "check") {
		throw new Error("Usage: generate <update|check>")
	}
	if (process.platform !== "linux") {
		throw new Error("VS Code theme fixtures must be generated on the canonical Linux environment")
	}
	if (!process.env.DISPLAY) {
		throw new Error(`Run theme fixture generation through "xvfb-run -a"`)
	}

	const packageRoot = path.resolve(__dirname, "../..")
	const repositoryRoot = path.resolve(packageRoot, "../..")
	const extensionDevelopmentPath = path.join(repositoryRoot, "src")
	const extensionTestsPath = path.resolve(__dirname, "extension")
	const fixtureDirectory = path.join(repositoryRoot, "webview-ui", "playwright", "themes")
	const vscodeVersion = await readPinnedVSCodeVersion(packageRoot)
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-code-theme-fixtures-"))
	const workspacePath = path.join(temporaryRoot, "workspace")
	const userDataPath = path.join(temporaryRoot, "user-data")
	const extensionsPath = path.join(temporaryRoot, "extensions")
	const capturePath = path.join(temporaryRoot, "captures.json")
	const generatedFixtureDirectory = path.join(temporaryRoot, "generated")

	try {
		await Promise.all([
			fs.mkdir(workspacePath),
			fs.mkdir(userDataPath),
			fs.mkdir(extensionsPath),
			fs.mkdir(generatedFixtureDirectory),
		])
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			version: vscodeVersion,
			launchArgs: [
				workspacePath,
				`--user-data-dir=${userDataPath}`,
				`--extensions-dir=${extensionsPath}`,
				"--disable-workspace-trust",
				"--skip-welcome",
				"--skip-release-notes",
			],
			extensionTestsEnv: {
				...process.env,
				ROO_CODE_THEME_FIXTURE_PROBE: "1",
				ROO_CODE_THEME_FIXTURE_CAPTURE_PATH: capturePath,
				ROO_CODE_THEME_FIXTURE_VSCODE_VERSION: vscodeVersion,
			},
		})

		const captures = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, WebviewThemeFixture>
		const generated = createSerializedFixtures(
			new Map(Object.entries(captures)),
			vscodeVersion,
			themeFixtureDefinitions,
		)
		await Promise.all(
			[...generated].map(([fileName, contents]) =>
				fs.writeFile(path.join(generatedFixtureDirectory, fileName), contents, "utf8"),
			),
		)

		if (mode === "check") {
			const [temporary, tracked] = await Promise.all([
				readTrackedFixtures(generatedFixtureDirectory, generated.keys()),
				readTrackedFixtures(fixtureDirectory, generated.keys()),
			])
			const expected = new Map<string, string>()
			for (const [fileName, contents] of temporary) {
				if (contents === undefined) {
					throw new Error(`Temporary fixture was not generated: ${fileName}`)
				}
				expected.set(fileName, contents)
			}
			const drifted = findDriftedFixtures(expected, tracked)
			if (drifted.length > 0) {
				throw new Error(
					`VS Code theme fixtures are out of date:\n${drifted.map((file) => `- ${file}`).join("\n")}`,
				)
			}
			console.log(`VS Code ${vscodeVersion} theme fixtures are current.`)
			return
		}

		await fs.mkdir(fixtureDirectory, { recursive: true })
		await Promise.all(
			[...generated.keys()].map((fileName) =>
				fs.copyFile(path.join(generatedFixtureDirectory, fileName), path.join(fixtureDirectory, fileName)),
			),
		)
		console.log(`Updated ${generated.size} theme fixtures from VS Code ${vscodeVersion}.`)
	} finally {
		await fs.rm(temporaryRoot, { recursive: true, force: true })
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
})
