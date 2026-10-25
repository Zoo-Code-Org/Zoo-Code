import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test, { type TestContext } from "node:test"

import { createScenarioWorkspace, preserveScenarioWorkspace, removeScenarioWorkspace } from "./scenarioWorkspace"

async function scenario(t: TestContext) {
	const workspace = await createScenarioWorkspace()
	const destination = path.resolve(__dirname, "../../test-failures", path.basename(workspace.root))
	t.after(async () => {
		await removeScenarioWorkspace(workspace)
		await fs.rm(destination, { recursive: true, force: true })
	})
	return { workspace, destination }
}

void test("publishes only metadata, including when raw copies would fail", async (t) => {
	const { workspace, destination } = await scenario(t)
	const secret = "private-prompt-and-api-key"
	const tasks = path.join(workspace.userData, "User/globalStorage/zoocodeorganization.zoo-code/tasks", secret)
	const logs = path.join(workspace.userData, "logs")
	await fs.mkdir(tasks, { recursive: true })
	await fs.mkdir(logs, { recursive: true })
	for (const name of ["ui_messages.json", "api_conversation_history.json", ".ui_messages.json.bak_secret.tmp"]) {
		await fs.writeFile(path.join(tasks, name), JSON.stringify({ text: secret }))
	}
	await fs.writeFile(path.join(logs, `${secret}.log`), secret)
	await fs.writeFile(
		path.join(workspace.results, "01-create.json"),
		JSON.stringify({
			version: 1,
			phase: "create",
			status: "failed",
			values: { secret },
			error: { message: secret, stack: secret },
		}),
	)
	const copy = t.mock.method(fs, "cp", () => {
		throw new Error("Raw copy must never run")
	})
	assert.equal(await preserveScenarioWorkspace(workspace), destination)
	assert.equal(copy.mock.callCount(), 0)
	assert.deepEqual(await fs.readdir(destination), ["diagnostics.json"])
	const manifest = await fs.readFile(path.join(destination, "diagnostics.json"), "utf8")
	assert(!manifest.includes(secret))
	assert(!manifest.includes(workspace.root))
	assert(manifest.includes('"sha256"'))
	assert(manifest.includes('"status": "failed"'))
	assert(manifest.includes('"ui_messages.json"'))
	await assert.rejects(fs.access(workspace.root), { code: "ENOENT" })
})

void test("classifies leftovers and publishes only validated trace fields", async (t) => {
	const { workspace, destination } = await scenario(t)
	const secret = "private-task-secret"
	const tasks = path.join(workspace.userData, "User/globalStorage/zoocodeorganization.zoo-code/tasks", secret)
	const logs = path.join(workspace.userData, "logs")
	await fs.mkdir(tasks, { recursive: true })
	await fs.mkdir(logs, { recursive: true })
	for (const name of [
		".ui_messages.json.bak_private.tmp",
		".api_conversation_history.json.new_private.tmp",
		"other.json",
	]) {
		await fs.writeFile(path.join(tasks, name), secret)
	}
	await fs.mkdir(path.join(tasks, "history_item.json.lock"))
	const first = { stage: "ui-messages-write-start", pid: 101, ts: "2026-10-24T12:00:00.000Z" }
	const second = { stage: "shutdown", pid: 202, ts: "2026-10-24T12:00:01.000Z" }
	const line = (event: object) => `[prefix] [persistence-trace] ${JSON.stringify(event)}`
	await fs.writeFile(
		path.join(logs, "extension.log"),
		[
			line({ ...second, taskId: secret, filePath: secret, detail: secret, result: secret }),
			line({ ...first, taskId: secret, filePath: secret, detail: secret }),
			line(first), // Console and output-channel copies must not duplicate events.
			line({ ...first, stage: secret }),
			line({ ...first, pid: secret }),
			line({ ...first, ts: secret }),
			"[persistence-trace] truncated {",
		].join("\n"),
	)
	await preserveScenarioWorkspace(workspace)
	const text = await fs.readFile(path.join(destination, "diagnostics.json"), "utf8")
	assert(!text.includes(secret))
	assert(!text.includes(".bak_private"))
	const diagnostic: {
		sources: Array<{
			label: string
			files?: Array<{ class: string; kind: string; directoryHash: string; target?: string; name?: string }>
		}>
		traces: unknown
	} = JSON.parse(text)
	assert.deepEqual(diagnostic.traces, [first, second])
	const files = diagnostic.sources.find((source) => source.label === "tasks")?.files
	assert(files)
	assert.deepEqual(files.map((file) => file.class).sort(), ["backup", "lock", "new-temp", "other"])
	assert.equal(new Set(files.map((file) => file.directoryHash)).size, 1)
	assert.equal(files.find((file) => file.class === "backup")?.target, "ui_messages.json")
	assert.equal(files.find((file) => file.class === "lock")?.kind, "directory")
	assert(!files.some((file) => file.name === "ui_messages.json"))
})

void test("skips absent optional directories", async (t) => {
	const { workspace, destination } = await scenario(t)
	await preserveScenarioWorkspace(workspace)
	const manifest = await fs.readFile(path.join(destination, "diagnostics.json"), "utf8")
	assert.equal((manifest.match(/"status": "missing"/g) ?? []).length, 2)
	await assert.rejects(fs.access(workspace.root), { code: "ENOENT" })
})

void test("records collection failures without copying raw files and still cleans the workspace", async (t) => {
	const { workspace, destination } = await scenario(t)
	await fs.writeFile(path.join(workspace.results, "01-create.json"), "private phase contents")
	const read = fs.readFile
	t.mock.method(fs, "readFile", (async (...args: Parameters<typeof fs.readFile>) => {
		if (String(args[0]).endsWith("01-create.json"))
			throw Object.assign(new Error("sensitive detail"), { code: "EIO" })
		return read(...args)
	}) as typeof fs.readFile)
	await preserveScenarioWorkspace(workspace)
	const manifest = await read(path.join(destination, "diagnostics.json"), "utf8")
	assert(manifest.includes('"code": "EIO"'))
	assert(manifest.includes('"kind": "error"'))
	assert(!manifest.includes("sensitive detail"))
	await assert.rejects(fs.access(workspace.root), { code: "ENOENT" })
})

for (const failure of ["partial write", "rename"] as const) {
	for (const existing of [false, true]) {
		void test(`keeps the source after a failed ${failure}, previous artifact: ${existing}`, async (t) => {
			const { workspace, destination } = await scenario(t)
			await fs.mkdir(destination, { recursive: true })
			const artifact = path.join(destination, "diagnostics.json")
			const previous = JSON.stringify({ previous: true })
			if (existing) await fs.writeFile(artifact, previous)
			const write = fs.writeFile
			if (failure === "partial write") {
				t.mock.method(fs, "writeFile", async (file: Parameters<typeof fs.writeFile>[0]) => {
					await write(file, '{"partial":')
					throw Object.assign(new Error("disk failed"), { code: "EIO" })
				})
			} else {
				t.mock.method(fs, "rename", async () => {
					throw Object.assign(new Error("rename failed"), { code: "EIO" })
				})
			}
			await assert.rejects(preserveScenarioWorkspace(workspace), { code: "EIO" })
			await fs.access(workspace.root)
			if (existing) assert.equal(await fs.readFile(artifact, "utf8"), previous)
			else await assert.rejects(fs.access(artifact), { code: "ENOENT" })
			assert.deepEqual(await fs.readdir(destination), existing ? ["diagnostics.json"] : [])
		})
	}
}

void test("publishes complete diagnostics before removing the source workspace", async (t) => {
	const { workspace, destination } = await scenario(t)
	const rename = fs.rename
	t.mock.method(fs, "rename", async (source: string, target: string) => {
		assert.equal(target, path.join(destination, "diagnostics.json"))
		await fs.access(workspace.root)
		await assert.rejects(fs.access(target), { code: "ENOENT" })
		assert(JSON.parse(await fs.readFile(source, "utf8")).sources)
		await rename(source, target)
	})
	await preserveScenarioWorkspace(workspace)
	assert.deepEqual(await fs.readdir(destination), ["diagnostics.json"])
	await assert.rejects(fs.access(workspace.root), { code: "ENOENT" })
})
