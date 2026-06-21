import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import {
	importRooTaskHistory,
	isConcurrentDestinationClaimError,
	resolveRooHistoryImportPaths,
} from "../importRooTaskHistory"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
	},
}))

const makeHistoryItem = (id: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ id, number: 1, ts: 1000, task: "t", tokensIn: 0, tokensOut: 0, totalCost: 0, ...extra })

describe("importRooTaskHistory", () => {
	let tempRoot: string

	const mockStorageConfiguration = ({
		roo = "",
		zoo = "",
		throwOnRoo = false,
	}: {
		roo?: string
		zoo?: string
		throwOnRoo?: boolean
	} = {}) => {
		const getConfigurationMock = vi.mocked(vscode.workspace.getConfiguration)

		getConfigurationMock.mockImplementation((section?: string) => {
			const resolvedSection = section ?? ""
			return {
				get: vi.fn().mockImplementation(() => {
					if (resolvedSection === "roo-cline" && throwOnRoo) {
						throw new Error("roo config unavailable")
					}

					if (resolvedSection === "roo-cline") {
						return roo
					}

					if (resolvedSection === "zoo-code") {
						return zoo
					}

					return ""
				}),
			} as any
		})
	}

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "roo-history-import-"))
		vi.clearAllMocks()
	})

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true })
	})

	it("resolves Roo and Zoo storage roots from extension domains and configured custom paths", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooCustomStoragePath = path.join(tempRoot, "roo-custom")
		const zooCustomStoragePath = path.join(tempRoot, "zoo-custom")

		mockStorageConfiguration({
			roo: rooCustomStoragePath,
			zoo: zooCustomStoragePath,
		})

		const result = await resolveRooHistoryImportPaths(zooGlobalStoragePath)

		expect(result.rooExtensionDomain).toBe("RooVeterinaryInc.roo-cline")
		expect(result.zooExtensionDomain).toBe("ZooCodeOrganization.zoo-code")
		expect(result.rooStorageRoots).toEqual([
			path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline"),
			rooCustomStoragePath,
		])
		expect(result.zooStorageRoot).toBe(zooCustomStoragePath)
	})

	it("falls back to the default Roo storage root when reading Roo custom storage fails", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")

		mockStorageConfiguration({ throwOnRoo: true })

		const result = await resolveRooHistoryImportPaths(zooGlobalStoragePath)

		expect(result.rooStorageRoots).toEqual([path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")])
		expect(result.zooStorageRoot).toBe(zooGlobalStoragePath)
	})

	it("dedupes Roo storage roots when the custom path matches the default Roo storage root", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")

		mockStorageConfiguration({ roo: rooDefaultStorageRoot })

		const result = await resolveRooHistoryImportPaths(zooGlobalStoragePath)

		expect(result.rooStorageRoots).toEqual([rooDefaultStorageRoot])
	})

	it("copies Roo task directories into the active Zoo storage root", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")
		const rooCustomStorageRoot = path.join(tempRoot, "roo-custom")
		const zooCustomStorageRoot = path.join(tempRoot, "zoo-custom")

		mockStorageConfiguration({
			roo: rooCustomStorageRoot,
			zoo: zooCustomStorageRoot,
		})

		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-default"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-default", "history_item.json"),
			makeHistoryItem("task-default"),
		)
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", "task-default", "ui_messages.json"), "default")
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", "_index.json"), "{}")

		await fs.mkdir(path.join(rooCustomStorageRoot, "tasks", "task-custom"), { recursive: true })
		await fs.writeFile(
			path.join(rooCustomStorageRoot, "tasks", "task-custom", "history_item.json"),
			makeHistoryItem("task-custom"),
		)
		await fs.writeFile(
			path.join(rooCustomStorageRoot, "tasks", "task-custom", "api_conversation_history.json"),
			"custom",
		)

		const result = await importRooTaskHistory(zooGlobalStoragePath)

		expect(result.foundTaskCount).toBe(2)
		expect(result.importedTaskCount).toBe(2)
		expect(result.importedFileCount).toBe(4)
		expect(
			await fs.readFile(path.join(zooCustomStorageRoot, "tasks", "task-default", "ui_messages.json"), "utf8"),
		).toBe("default")
		expect(
			await fs.readFile(
				path.join(zooCustomStorageRoot, "tasks", "task-custom", "api_conversation_history.json"),
				"utf8",
			),
		).toBe("custom")
		await expect(fs.access(path.join(zooCustomStorageRoot, "tasks", "_index.json"))).rejects.toMatchObject({
			code: "ENOENT",
		})
	})

	it("does not overwrite an existing Zoo task directory when the same Roo history is imported again", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")

		mockStorageConfiguration()

		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-repeat"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-repeat", "history_item.json"),
			makeHistoryItem("task-repeat", { source: "first-import" }),
		)
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", "task-repeat", "ui_messages.json"), "first-ui")

		const firstImportResult = await importRooTaskHistory(zooGlobalStoragePath)

		expect(firstImportResult.importedTaskCount).toBe(1)
		expect(firstImportResult.importedFileCount).toBe(2)

		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-repeat", "history_item.json"),
			makeHistoryItem("task-repeat", { source: "second-import" }),
		)
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", "task-repeat", "ui_messages.json"), "second-ui")

		const secondImportResult = await importRooTaskHistory(zooGlobalStoragePath)

		expect(secondImportResult.foundTaskCount).toBe(1)
		expect(secondImportResult.importedTaskCount).toBe(0)
		expect(secondImportResult.importedFileCount).toBe(0)
		expect(
			await fs.readFile(path.join(zooGlobalStoragePath, "tasks", "task-repeat", "history_item.json"), "utf8"),
		).toBe(makeHistoryItem("task-repeat", { source: "first-import" }))
		expect(
			await fs.readFile(path.join(zooGlobalStoragePath, "tasks", "task-repeat", "ui_messages.json"), "utf8"),
		).toBe("first-ui")
	})

	it("deterministically keeps the first importable Roo task when duplicate task IDs exist across roots", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")
		const rooCustomStorageRoot = path.join(tempRoot, "roo-custom")

		mockStorageConfiguration({ roo: rooCustomStorageRoot })

		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-shared"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-shared", "history_item.json"),
			makeHistoryItem("task-shared", { source: "default-root" }),
		)
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", "task-shared", "ui_messages.json"), "default-ui")

		await fs.mkdir(path.join(rooCustomStorageRoot, "tasks", "task-shared"), { recursive: true })
		await fs.writeFile(
			path.join(rooCustomStorageRoot, "tasks", "task-shared", "history_item.json"),
			makeHistoryItem("task-shared", { source: "custom-root" }),
		)
		await fs.writeFile(path.join(rooCustomStorageRoot, "tasks", "task-shared", "ui_messages.json"), "custom-ui")

		await fs.mkdir(path.join(rooCustomStorageRoot, "tasks", "task-custom-only"), { recursive: true })
		await fs.writeFile(
			path.join(rooCustomStorageRoot, "tasks", "task-custom-only", "history_item.json"),
			makeHistoryItem("task-custom-only", { source: "custom-root" }),
		)
		await fs.writeFile(
			path.join(rooCustomStorageRoot, "tasks", "task-custom-only", "ui_messages.json"),
			"custom-only-ui",
		)

		const result = await importRooTaskHistory(zooGlobalStoragePath)

		expect(result.importedTaskCount).toBe(2)
		expect(result.importedFileCount).toBe(4)
		expect(
			await fs.readFile(path.join(zooGlobalStoragePath, "tasks", "task-shared", "history_item.json"), "utf8"),
		).toBe(makeHistoryItem("task-shared", { source: "default-root" }))
		expect(
			await fs.readFile(path.join(zooGlobalStoragePath, "tasks", "task-shared", "ui_messages.json"), "utf8"),
		).toBe("default-ui")
		expect(
			await fs.readFile(
				path.join(zooGlobalStoragePath, "tasks", "task-custom-only", "history_item.json"),
				"utf8",
			),
		).toBe(makeHistoryItem("task-custom-only", { source: "custom-root" }))
	})

	it("reports Roo history import progress as files are copied", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")
		const onProgress = vi.fn()

		mockStorageConfiguration()

		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-progress"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-progress", "history_item.json"),
			makeHistoryItem("task-progress"),
		)
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", "task-progress", "ui_messages.json"), "ui")
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-progress", "api_conversation_history.json"),
			"api",
		)

		await importRooTaskHistory(zooGlobalStoragePath, onProgress)

		expect(onProgress.mock.calls).toEqual([
			[
				{
					copiedFileCount: 0,
					totalFileCount: 3,
					importedTaskCount: 0,
					totalTaskCount: 1,
					currentTaskId: undefined,
					currentFileName: undefined,
				},
			],
			[
				{
					copiedFileCount: 1,
					totalFileCount: 3,
					importedTaskCount: 1,
					totalTaskCount: 1,
					currentTaskId: "task-progress",
					currentFileName: "history_item.json",
				},
			],
			[
				{
					copiedFileCount: 2,
					totalFileCount: 3,
					importedTaskCount: 1,
					totalTaskCount: 1,
					currentTaskId: "task-progress",
					currentFileName: "ui_messages.json",
				},
			],
			[
				{
					copiedFileCount: 3,
					totalFileCount: 3,
					importedTaskCount: 1,
					totalTaskCount: 1,
					currentTaskId: "task-progress",
					currentFileName: "api_conversation_history.json",
				},
			],
		])
	})

	it("imports only top-level task history files and skips checkpoint directories", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")
		const zooCustomStorageRoot = path.join(tempRoot, "shared-storage")

		mockStorageConfiguration({
			roo: zooCustomStorageRoot,
			zoo: zooCustomStorageRoot,
		})

		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-visible", "checkpoints", ".git", "objects"), {
			recursive: true,
		})
		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", ".task-hidden"), { recursive: true })
		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "_task-hidden"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-visible", "history_item.json"),
			makeHistoryItem("task-visible"),
		)
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", "task-visible", "ui_messages.json"), "visible-ui")
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-visible", "api_conversation_history.json"),
			"visible-api",
		)
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", "task-visible", "task_metadata.json"), "metadata")
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", "loose.json"), "loose")
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-visible", "checkpoints", ".git", "objects", "object"),
			"git-object",
		)
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", ".task-hidden", "history_item.json"), "hidden-dir")
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", "_task-hidden", "history_item.json"), "hidden-dir")

		const result = await importRooTaskHistory(zooGlobalStoragePath)

		expect(result.rooStorageRoots).toEqual([rooDefaultStorageRoot])
		expect(result.importedTaskCount).toBe(1)
		expect(result.importedFileCount).toBe(4)
		expect(
			await fs.readFile(path.join(zooCustomStorageRoot, "tasks", "task-visible", "ui_messages.json"), "utf8"),
		).toBe("visible-ui")
		expect(
			await fs.readFile(
				path.join(zooCustomStorageRoot, "tasks", "task-visible", "api_conversation_history.json"),
				"utf8",
			),
		).toBe("visible-api")
		expect(
			await fs.readFile(path.join(zooCustomStorageRoot, "tasks", "task-visible", "task_metadata.json"), "utf8"),
		).toBe("metadata")
		await expect(fs.access(path.join(zooCustomStorageRoot, "tasks", ".task-hidden"))).rejects.toMatchObject({
			code: "ENOENT",
		})
		await expect(fs.access(path.join(zooCustomStorageRoot, "tasks", "_task-hidden"))).rejects.toMatchObject({
			code: "ENOENT",
		})
		await expect(
			fs.access(
				path.join(zooCustomStorageRoot, "tasks", "task-visible", "checkpoints", ".git", "objects", "object"),
			),
		).rejects.toMatchObject({
			code: "ENOENT",
		})
		await expect(fs.access(path.join(zooCustomStorageRoot, "tasks", "loose.json"))).rejects.toMatchObject({
			code: "ENOENT",
		})
	})

	it("ignores missing Roo task roots while still importing from available roots", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")
		const rooMissingCustomStorageRoot = path.join(tempRoot, "roo-missing")

		mockStorageConfiguration({ roo: rooMissingCustomStorageRoot })

		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-default"), { recursive: true })
		const taskDefaultHistoryJson = JSON.stringify({
			id: "task-default",
			number: 1,
			ts: 1000,
			task: "t",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		})
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-default", "history_item.json"),
			taskDefaultHistoryJson,
		)

		const result = await importRooTaskHistory(zooGlobalStoragePath)

		expect(result.rooStorageRoots).toEqual([rooDefaultStorageRoot, rooMissingCustomStorageRoot])
		expect(result.importedTaskCount).toBe(1)
		expect(result.importedFileCount).toBe(1)
		expect(
			await fs.readFile(path.join(zooGlobalStoragePath, "tasks", "task-default", "history_item.json"), "utf8"),
		).toBe(taskDefaultHistoryJson)
	})

	it("skips tasks that do not have an importable history_item.json", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")

		mockStorageConfiguration()

		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-missing-history"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-missing-history", "ui_messages.json"),
			"ui only",
		)

		const result = await importRooTaskHistory(zooGlobalStoragePath)

		expect(result.importedTaskCount).toBe(0)
		expect(result.importedFileCount).toBe(0)
		await expect(fs.access(path.join(zooGlobalStoragePath, "tasks", "task-missing-history"))).rejects.toMatchObject(
			{
				code: "ENOENT",
			},
		)
	})

	it("does not delete an existing Zoo task when the Roo task is missing history_item.json", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")
		const existingZooTaskDirectory = path.join(zooGlobalStoragePath, "tasks", "task-existing")

		mockStorageConfiguration()

		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-existing"), { recursive: true })
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", "task-existing", "ui_messages.json"), "ui only")
		await fs.mkdir(existingZooTaskDirectory, { recursive: true })
		await fs.writeFile(path.join(existingZooTaskDirectory, "history_item.json"), "existing")

		const result = await importRooTaskHistory(zooGlobalStoragePath)

		expect(result.importedTaskCount).toBe(0)
		expect(result.importedFileCount).toBe(0)
		expect(await fs.readFile(path.join(existingZooTaskDirectory, "history_item.json"), "utf8")).toBe("existing")
	})

	it("does not overwrite an existing Zoo task when the Roo task is otherwise importable", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")
		const existingZooTaskDirectory = path.join(zooGlobalStoragePath, "tasks", "task-existing")

		mockStorageConfiguration()

		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-existing"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-existing", "history_item.json"),
			makeHistoryItem("task-existing", { source: "roo" }),
		)
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks", "task-existing", "ui_messages.json"), "roo-ui")
		await fs.mkdir(existingZooTaskDirectory, { recursive: true })
		await fs.writeFile(path.join(existingZooTaskDirectory, "history_item.json"), "existing")
		await fs.writeFile(path.join(existingZooTaskDirectory, "ui_messages.json"), "existing-ui")

		const result = await importRooTaskHistory(zooGlobalStoragePath)

		expect(result.importedTaskCount).toBe(0)
		expect(result.importedFileCount).toBe(0)
		expect(await fs.readFile(path.join(existingZooTaskDirectory, "history_item.json"), "utf8")).toBe("existing")
		expect(await fs.readFile(path.join(existingZooTaskDirectory, "ui_messages.json"), "utf8")).toBe("existing-ui")
	})

	it("rejects task IDs containing dots or underscore prefixes to prevent traversal", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")

		mockStorageConfiguration()

		// These directory names look like valid FS entries but should be rejected.
		// (Slash/backslash can't exist in directory names on Linux/Mac/Windows.)
		const unsafeCandidates = ["task.id", ".hidden-task", "_reserved-task"]
		for (const name of unsafeCandidates) {
			const dir = path.join(rooDefaultStorageRoot, "tasks", name)
			await fs.mkdir(dir, { recursive: true })
			await fs.writeFile(path.join(dir, "history_item.json"), "unsafe")
		}

		// A safe task alongside unsafe ones should still be imported.
		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-safe"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-safe", "history_item.json"),
			makeHistoryItem("task-safe"),
		)

		const result = await importRooTaskHistory(zooGlobalStoragePath)

		expect(result.importedTaskCount).toBe(1)
		for (const name of unsafeCandidates) {
			await expect(fs.access(path.join(zooGlobalStoragePath, "tasks", name))).rejects.toMatchObject({
				code: "ENOENT",
			})
		}
	})

	it("rejects tasks whose history_item.json id field does not match the directory name or contains unsafe characters", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")

		mockStorageConfiguration()

		// id mismatches the directory name — could drive path traversal in TaskHistoryStore
		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-mismatch"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-mismatch", "history_item.json"),
			makeHistoryItem("different-task-id"),
		)

		// id contains a path traversal sequence
		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-traversal"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-traversal", "history_item.json"),
			makeHistoryItem("../../evil"),
		)

		// id fails schema validation (not a valid HistoryItem)
		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-invalid-schema"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-invalid-schema", "history_item.json"),
			JSON.stringify({ id: "task-invalid-schema" }),
		)

		// A task with a correct, schema-valid id should still import.
		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-valid"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-valid", "history_item.json"),
			makeHistoryItem("task-valid"),
		)

		const result = await importRooTaskHistory(zooGlobalStoragePath)

		expect(result.importedTaskCount).toBe(1)
		await expect(fs.access(path.join(zooGlobalStoragePath, "tasks", "task-mismatch"))).rejects.toMatchObject({
			code: "ENOENT",
		})
		await expect(fs.access(path.join(zooGlobalStoragePath, "tasks", "task-traversal"))).rejects.toMatchObject({
			code: "ENOENT",
		})
		await expect(fs.access(path.join(zooGlobalStoragePath, "tasks", "task-invalid-schema"))).rejects.toMatchObject({
			code: "ENOENT",
		})
		await expect(fs.access(path.join(zooGlobalStoragePath, "tasks", "task-valid"))).resolves.toBeUndefined()
	})

	it("rethrows unexpected task-root errors while importing Roo history", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")

		mockStorageConfiguration()

		await fs.mkdir(rooDefaultStorageRoot, { recursive: true })
		await fs.writeFile(path.join(rooDefaultStorageRoot, "tasks"), "not a directory")

		await expect(importRooTaskHistory(zooGlobalStoragePath)).rejects.toMatchObject({
			code: "ENOTDIR",
		})
	})

	it("treats Windows EPERM rename as a concurrent destination claim only when the destination exists", () => {
		const error = new Error("operation not permitted") as NodeJS.ErrnoException
		error.code = "EPERM"

		expect(isConcurrentDestinationClaimError(error, true)).toBe(true)
		expect(isConcurrentDestinationClaimError(error, false)).toBe(false)
	})

	it("imports the complete file set when two calls run concurrently against the same Roo task", async () => {
		const zooGlobalStoragePath = path.join(tempRoot, "globalStorage", "zoocodeorganization.zoo-code")
		const rooDefaultStorageRoot = path.join(tempRoot, "globalStorage", "rooveterinaryinc.roo-cline")

		mockStorageConfiguration()

		await fs.mkdir(path.join(rooDefaultStorageRoot, "tasks", "task-concurrent"), { recursive: true })
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-concurrent", "history_item.json"),
			makeHistoryItem("task-concurrent"),
		)
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-concurrent", "ui_messages.json"),
			"concurrent-ui",
		)
		await fs.writeFile(
			path.join(rooDefaultStorageRoot, "tasks", "task-concurrent", "api_conversation_history.json"),
			"concurrent-api",
		)

		const [result1, result2] = await Promise.all([
			importRooTaskHistory(zooGlobalStoragePath),
			importRooTaskHistory(zooGlobalStoragePath),
		])

		// Exactly one call should win the atomic rename; the other should skip gracefully.
		expect(result1.importedTaskCount + result2.importedTaskCount).toBe(1)

		const destTaskDir = path.join(zooGlobalStoragePath, "tasks", "task-concurrent")

		// The winning import must have written all three files completely.
		expect(await fs.readFile(path.join(destTaskDir, "history_item.json"), "utf8")).toBe(
			makeHistoryItem("task-concurrent"),
		)
		expect(await fs.readFile(path.join(destTaskDir, "ui_messages.json"), "utf8")).toBe("concurrent-ui")
		expect(await fs.readFile(path.join(destTaskDir, "api_conversation_history.json"), "utf8")).toBe(
			"concurrent-api",
		)

		// No staging directories should be left behind.
		const tasksEntries = await fs.readdir(path.join(zooGlobalStoragePath, "tasks"))
		expect(tasksEntries.filter((e) => e.startsWith("_staging_"))).toHaveLength(0)
	})
})
