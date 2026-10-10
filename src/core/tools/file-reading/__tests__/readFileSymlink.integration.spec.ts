import * as fs from "fs/promises"
import os from "os"
import path from "path"
import * as vscode from "vscode"
import ExcelJS from "exceljs"
import type { ClineSayTool } from "@roo-code/types"
import type { Task } from "../../../task/Task"
import { checkAutoApproval } from "../../../auto-approval"
import { ReadFileTool } from "../ReadFileTool"
import { LegacyFileReader } from "../LegacyFileReader"
import { RooIgnoreController } from "../../../ignore/RooIgnoreController"

// Call-through host instrumentation; filesystem behavior and approval policy remain real.
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile), lstat: vi.fn(actual.lstat) }
})

vi.mock("vscode", async (importOriginal) => {
	const actual = await importOriginal<typeof import("vscode")>()
	return {
		...actual,
		RelativePattern: class {
			constructor(
				readonly base: string,
				readonly pattern: string,
			) {}
		},
	}
})

describe("file reader resolved-target permission boundary", () => {
	let directory: string
	let workspace: string
	let external: string
	let task: ReturnType<typeof createTask>
	let manualApproval: ReturnType<typeof vi.fn<() => Promise<Awaited<ReturnType<Task["ask"]>>>>>
	let approvalMessages: ClineSayTool[]

	function createTask() {
		return {
			cwd: workspace,
			abort: false,
			abandoned: false,
			didToolFailInCurrentTurn: false,
			didRejectTool: false,
			rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
			say: vi.fn().mockResolvedValue(undefined),
			fileContextTracker: { trackFileContext: vi.fn().mockResolvedValue(undefined) },
			api: { getModel: () => ({ info: { supportsImages: true } }) },
			providerRef: { deref: () => ({ getState: async () => ({}) }) },
			ask: vi.fn<Task["ask"]>(async (ask, text) => {
				approvalMessages.push(JSON.parse(text ?? "{}"))
				const policy = await checkAutoApproval({
					cwd: workspace,
					ask,
					text,
					state: {
						autoApprovalEnabled: true,
						alwaysAllowReadOnly: true,
						alwaysAllowReadOnlyOutsideWorkspace: false,
						allowedReadFiles: [],
						alwaysAllowWrite: false,
						alwaysAllowWriteOutsideWorkspace: false,
						alwaysAllowWriteProtected: false,
						alwaysAllowMcp: false,
						alwaysAllowModeSwitch: false,
						alwaysAllowSubtasks: false,
						alwaysAllowExecute: false,
						alwaysAllowFollowupQuestions: false,
					},
				})
				return policy.decision === "approve" ? { response: "yesButtonClicked" } : manualApproval()
			}),
		}
	}

	function read(file: string, textOnly = true) {
		// The host double intentionally omits Task members unrelated to file reading.
		return new ReadFileTool().readEntry({ path: file }, task as unknown as Task, { textOnly })
	}

	async function replaceAfterOpening(filePath: string, replacement: string) {
		const { open } = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const file = await open(...args)
			if (args[0] === filePath) {
				await fs.rename(filePath, `${filePath}.original`)
				await fs.symlink(replacement, filePath)
			}
			return file
		})
	}

	beforeEach(async () => {
		vi.clearAllMocks()
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.open).mockImplementation(actual.open)
		vi.mocked(fs.readFile).mockImplementation(actual.readFile)
		vi.mocked(fs.lstat).mockImplementation(actual.lstat)
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "zoo-symlink-reading-")))
		workspace = path.join(directory, "workspace")
		external = path.join(directory, "external.txt")
		await fs.mkdir(workspace)
		await fs.writeFile(external, "synthetic external secret")
		vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue([
			{ uri: vscode.Uri.file(workspace), name: "workspace", index: 0 },
		])
		approvalMessages = []
		manualApproval = vi.fn().mockResolvedValue({ response: "noButtonClicked" })
		task = createTask()
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("requires manual approval for an internal symlink to an external file under the real policy", async () => {
		await fs.symlink(external, path.join(workspace, "linked.txt"))

		const result = await read("linked.txt")

		expect(manualApproval).toHaveBeenCalledOnce()
		expect(approvalMessages[0]).toMatchObject({ isOutsideWorkspace: true, content: external })
		expect(result.status).toBe("denied")
		expect(JSON.stringify(result)).not.toContain("synthetic external secret")
		expect(fs.open).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("does not disclose a new symlink target replacing the approved canonical filename while approval waits", async () => {
		const unapproved = path.join(directory, "unapproved.txt")
		await fs.writeFile(unapproved, "unapproved replacement secret")
		await fs.symlink(external, path.join(workspace, "linked.txt"))
		manualApproval.mockImplementation(async () => {
			await fs.rename(external, `${external}.original`)
			await fs.symlink(unapproved, external)
			return { response: "yesButtonClicked" }
		})

		const result = await read("linked.txt")

		expect(manualApproval).toHaveBeenCalledOnce()
		expect(JSON.stringify(result)).not.toContain("unapproved replacement secret")
		expect(result.status).toBe("error")
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("extracts notebook bytes from the verified file even when its canonical name is replaced after opening", async () => {
		const notebook = path.join(workspace, "example.ipynb")
		const unapproved = path.join(directory, "unapproved.ipynb")
		await fs.writeFile(notebook, JSON.stringify({ cells: [{ cell_type: "code", source: ["approved source"] }] }))
		await fs.writeFile(
			unapproved,
			JSON.stringify({ cells: [{ cell_type: "code", source: ["unapproved source"] }] }),
		)
		await replaceAfterOpening(notebook, unapproved)

		const result = await read("example.ipynb")

		expect(result.status).toBe("approved")
		expect(result.nativeContent).toContain("approved source")
		expect(result.nativeContent).not.toContain("unapproved source")
	})

	it("ordinary XLSX extraction consumes only the approved descriptor bytes after a filename replacement", async () => {
		const spreadsheet = path.join(workspace, "example.xlsx")
		const unapproved = path.join(directory, "unapproved.xlsx")
		for (const [file, text] of [
			[spreadsheet, "original sheet"],
			[unapproved, "unapproved sheet"],
		]) {
			const workbook = new ExcelJS.Workbook()
			workbook.addWorksheet("Data").addRow([text])
			await workbook.xlsx.writeFile(file)
		}
		await replaceAfterOpening(spreadsheet, unapproved)

		const result = await read("example.xlsx", false)

		expect(result.status).toBe("approved")
		expect(result.nativeContent).toContain("original sheet")
		expect(result.nativeContent).not.toContain("unapproved sheet")
	})

	it("returns image bytes only from the approved descriptor after a filename replacement", async () => {
		const image = path.join(workspace, "image.png")
		const replacement = path.join(directory, "unapproved.png")
		const original = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=",
			"base64",
		)
		await fs.writeFile(image, original)
		await fs.writeFile(replacement, "unapproved image bytes")
		await replaceAfterOpening(image, replacement)

		const result = await read("image.png", false)

		expect(result.status).toBe("approved")
		expect(result.imageDataUrl).toBe(`data:image/png;base64,${original.toString("base64")}`)
	})

	it("requires the same manual external-target approval in the legacy reader without changing its string contract", async () => {
		await fs.symlink(external, path.join(workspace, "linked.txt"))
		// The host double intentionally omits Task members unrelated to file reading.
		const result = await new LegacyFileReader().read([{ path: "linked.txt" }], task as unknown as Task)

		expect(manualApproval).toHaveBeenCalledOnce()
		expect(approvalMessages[0]).toMatchObject({ isOutsideWorkspace: true, content: external })
		expect(result).toBe("File: linked.txt\nStatus: Denied by user")
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("keeps ordinary internal files auto-approved under the real policy", async () => {
		await fs.writeFile(path.join(workspace, "normal.txt"), "normal workspace content")

		const result = await read("normal.txt")

		expect(manualApproval).not.toHaveBeenCalled()
		expect(approvalMessages[0]).toMatchObject({ isOutsideWorkspace: false, path: "normal.txt" })
		expect(result.nativeContent).toBe("File: normal.txt\n1 | normal workspace content")
	})

	it("does no content I/O while a direct external read awaits manual approval, then reads the approved file", async () => {
		let release!: (value: Awaited<ReturnType<Task["ask"]>>) => void
		let entered!: () => void
		const waiting = new Promise<void>((resolve) => {
			entered = resolve
		})
		manualApproval.mockImplementation(() => {
			entered()
			return new Promise((resolve) => {
				release = resolve
			})
		})
		const pending = read(external)
		await waiting
		expect(fs.open).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		release({ response: "yesButtonClicked" })

		const result = await pending

		expect(result.nativeContent).toContain("synthetic external secret")
		expect(approvalMessages[0]).toMatchObject({ isOutsideWorkspace: true, content: external })
	})

	it("reads the approved original target if the requested symlink is retargeted while manual approval waits", async () => {
		const linked = path.join(workspace, "linked.txt")
		const unapproved = path.join(directory, "unapproved.txt")
		await fs.writeFile(unapproved, "unapproved retargeted secret")
		await fs.symlink(external, linked)
		let release!: (value: Awaited<ReturnType<Task["ask"]>>) => void
		let entered!: () => void
		const waiting = new Promise<void>((resolve) => {
			entered = resolve
		})
		manualApproval.mockImplementation(() => {
			entered()
			return new Promise((resolve) => {
				release = resolve
			})
		})
		const pending = read("linked.txt")
		await waiting
		expect(fs.open).not.toHaveBeenCalled()
		await fs.unlink(linked)
		await fs.symlink(unapproved, linked)
		release({ response: "yesButtonClicked" })

		const result = await pending

		expect(result.nativeContent).toBe("File: linked.txt\n1 | synthetic external secret")
		expect(JSON.stringify(result)).not.toContain("unapproved retargeted secret")
	})

	it("keeps a symlink to an ignored internal target blocked without approval or content I/O", async () => {
		await fs.writeFile(path.join(workspace, "private.txt"), "ignored synthetic secret")
		await fs.writeFile(path.join(workspace, ".rooignore"), "private.txt\n")
		await fs.symlink(path.join(workspace, "private.txt"), path.join(workspace, "linked.txt"))
		const ignore = new RooIgnoreController(workspace)
		try {
			await ignore.initialize()
			task.rooIgnoreController.validateAccess.mockImplementation((file: string) => ignore.validateAccess(file))
			vi.mocked(fs.readFile).mockClear()

			const result = await read("linked.txt")

			expect(result.status).toBe("blocked")
			expect(task.ask).not.toHaveBeenCalled()
			expect(fs.open).not.toHaveBeenCalled()
			expect(fs.readFile).not.toHaveBeenCalled()
			expect(JSON.stringify(result)).not.toContain("ignored synthetic secret")
		} finally {
			ignore.dispose()
		}
	})

	it("rejects a replacement regular file before reading bytes and closes the mismatched descriptor", async () => {
		let opened: fs.FileHandle | undefined
		const { open } = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const readBytes = vi.fn()
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			opened = await open(...args)
			vi.spyOn(opened, "read").mockImplementation(readBytes)
			vi.spyOn(opened, "readFile").mockImplementation(readBytes)
			return opened
		})
		manualApproval.mockImplementation(async () => {
			await fs.rename(external, `${external}.original`)
			await fs.writeFile(external, "unapproved regular replacement")
			return { response: "yesButtonClicked" }
		})

		const result = await read(external)

		expect(result.status).toBe("error")
		expect(result.error).toContain("File target changed after approval")
		expect(readBytes).not.toHaveBeenCalled()
		expect(opened?.fd).toBe(-1)
		expect(JSON.stringify(result)).not.toContain("unapproved regular replacement")
	})

	it("legacy reading rejects a canonical filename replaced with a symlink during manual approval", async () => {
		const replacement = path.join(directory, "replacement.txt")
		await fs.writeFile(replacement, "unapproved legacy secret")
		await fs.symlink(external, path.join(workspace, "linked.txt"))
		manualApproval.mockImplementation(async () => {
			await fs.rename(external, `${external}.original`)
			await fs.symlink(replacement, external)
			return { response: "yesButtonClicked" }
		})
		// The host double intentionally omits Task members unrelated to file reading.
		const result = await new LegacyFileReader().read([{ path: "linked.txt" }], task as unknown as Task)

		expect(manualApproval).toHaveBeenCalledOnce()
		expect(result).toContain("File: linked.txt\nError:")
		expect(result).not.toContain("unapproved legacy secret")
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("preserves missing-file diagnostics without opening or reading content", async () => {
		const result = await read("missing.txt")

		expect(result.status).toBe("error")
		expect(result.error).toContain("ENOENT")
		expect(result.error).toContain("missing.txt")
		expect(fs.open).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it("keeps normal internal files auto-approved when the workspace folder itself is a symlink", async () => {
		await fs.writeFile(path.join(workspace, "normal.txt"), "normal workspace content")
		const alias = path.join(directory, "workspace-alias")
		await fs.symlink(workspace, alias, "dir")
		workspace = alias
		task.cwd = alias
		vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue([
			{ uri: vscode.Uri.file(alias), name: "workspace", index: 0 },
		])

		const result = await read("normal.txt")

		expect(manualApproval).not.toHaveBeenCalled()
		expect(result.nativeContent).toBe("File: normal.txt\n1 | normal workspace content")
		expect(approvalMessages[0].isOutsideWorkspace).toBe(false)
	})

	it("fails closed if a canonical parent directory is retargeted between resolution and identity capture", async () => {
		const parent = path.join(workspace, "nested")
		const outside = path.join(directory, "outside")
		await fs.mkdir(parent)
		await fs.mkdir(outside)
		await fs.writeFile(path.join(parent, "file.txt"), "original internal source")
		await fs.writeFile(path.join(outside, "file.txt"), "unapproved parent-retargeted secret")
		const { lstat } = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
			if (args[0] === path.join(parent, "file.txt")) {
				await fs.rename(parent, `${parent}.original`)
				await fs.symlink(outside, parent, "dir")
			}
			return lstat(...args)
		})

		const result = await read("nested/file.txt")

		expect(result.status).toBe("error")
		expect(JSON.stringify(result)).not.toContain("unapproved parent-retargeted secret")
		expect(task.ask).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("releases the approved descriptor when real notebook extraction fails", async () => {
		await fs.writeFile(path.join(workspace, "broken.ipynb"), "invalid notebook JSON")
		let opened: fs.FileHandle | undefined
		const { open } = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			opened = await open(...args)
			return opened
		})

		const result = await read("broken.ipynb")

		expect(result.status).toBe("error")
		expect(opened?.fd).toBe(-1)
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})
})
