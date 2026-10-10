import * as fs from "fs/promises"
import os from "os"
import path from "path"
import * as vscode from "vscode"
import ExcelJS from "exceljs"
import { isBinaryFile } from "isbinaryfile"
import mammoth from "mammoth"
import type { ClineSayTool, ReadFileToolParams } from "@roo-code/types"
import type { Task } from "../../../task/Task"
import { checkAutoApproval } from "../../../auto-approval"
import { readFileTool } from "../../ReadFileTool"
import * as imageHelpers from "../../helpers/imageHelpers"
import { RooIgnoreController } from "../../../ignore/RooIgnoreController"

// Instrument host I/O without replacing real filesystem behavior.
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		open: vi.fn(actual.open),
		readFile: vi.fn(actual.readFile),
		realpath: vi.fn(actual.realpath),
		lstat: vi.fn(actual.lstat),
	}
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

vi.mock("isbinaryfile", async (importOriginal) => {
	const actual = await importOriginal<typeof import("isbinaryfile")>()
	return { ...actual, isBinaryFile: vi.fn(actual.isBinaryFile) }
})

// Keep decoder protocols at the library boundary; approval and descriptor I/O remain real.
vi.mock("pdf-parse/lib/pdf-parse", () => ({ default: async (source: Buffer) => ({ text: source.toString() }) }))
vi.mock("mammoth", () => ({
	default: {
		extractRawText: async (options: { buffer?: Buffer; path?: string }) => ({
			value: options.buffer?.toString() ?? (await fs.readFile(options.path!, "utf8")),
		}),
	},
}))

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: Error) => void
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept
		reject = fail
	})
	return { promise, resolve, reject }
}

describe("public file reader safety", () => {
	let directory: string
	let workspace: string
	let external: string
	let task: ReturnType<typeof createTask>
	let approvalMessages: ClineSayTool[]
	let manualApproval: ReturnType<typeof vi.fn<Task["ask"]>>
	let openedFiles: fs.FileHandle[]
	const callbacks = { pushToolResult: vi.fn(), askApproval: vi.fn(), handleError: vi.fn() }

	function createTask(settings: Partial<NonNullable<Parameters<typeof checkAutoApproval>[0]["state"]>> = {}) {
		return {
			cwd: workspace,
			abort: false,
			abandoned: false,
			didToolFailInCurrentTurn: false,
			didRejectTool: false,
			rooIgnoreController: { validateAccess: vi.fn<(file: string) => boolean>().mockReturnValue(true) },
			say: vi.fn<Task["say"]>().mockResolvedValue(undefined),
			fileContextTracker: { trackFileContext: vi.fn().mockResolvedValue(undefined) },
			api: { getModel: () => ({ info: { supportsImages: true } }) },
			providerRef: { deref: () => ({ getState: async () => ({}) }) },
			ask: vi.fn<Task["ask"]>(async (ask, text) => {
				approvalMessages.push(JSON.parse(text ?? "{}"))
				const policy = await checkAutoApproval({
					cwd: task.cwd,
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
						...settings,
					},
				})
				return policy.decision === "approve" ? { response: "yesButtonClicked" } : manualApproval(ask, text)
			}),
		}
	}

	async function read(params: ReadFileToolParams) {
		// This host double intentionally omits Task members unrelated to file reading.
		await readFileTool.execute(params, task as unknown as Task, callbacks)
		return JSON.stringify(callbacks.pushToolResult.mock.calls)
	}

	async function replaceAfterOpening(filePath: string, replacement: string) {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.open)
			.mockReset()
			.mockImplementation(async (...args) => {
				const file = await actual.open(...args)
				openedFiles.push(file)
				if (args[0] === filePath) {
					await fs.rename(filePath, `${filePath}.original`)
					await fs.symlink(replacement, filePath)
				}
				return file
			})
	}

	async function inspectOpenedFile(inspect: (file: fs.FileHandle) => void) {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await actual.open(...args)
			openedFiles.push(file)
			inspect(file)
			return file
		})
	}

	beforeEach(async () => {
		vi.clearAllMocks()
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		openedFiles = []
		vi.mocked(fs.open)
			.mockReset()
			.mockImplementation(async (...args) => {
				const file = await actual.open(...args)
				openedFiles.push(file)
				return file
			})
		vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile)
		vi.mocked(fs.realpath).mockReset().mockImplementation(actual.realpath)
		vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat)
		const binary = await vi.importActual<typeof import("isbinaryfile")>("isbinaryfile")
		vi.mocked(isBinaryFile).mockReset().mockImplementation(binary.isBinaryFile)
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "zoo-file-safety-")))
		workspace = path.join(directory, "workspace")
		external = path.join(directory, "external.txt")
		await fs.mkdir(workspace)
		await fs.writeFile(external, "synthetic external secret")
		vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue([
			{ uri: vscode.Uri.file(workspace), name: "workspace", index: 0 },
		])
		approvalMessages = []
		manualApproval = vi.fn<Task["ask"]>().mockResolvedValue({ response: "noButtonClicked" })
		task = createTask()
	})

	afterEach(async () => {
		expect(openedFiles.every((file) => file.fd === -1)).toBe(true)
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("requires manual external approval for an internal symlink under the real policy", async () => {
		await fs.symlink(external, path.join(workspace, "linked.txt"))

		const result = await read({ path: "linked.txt" })

		expect(manualApproval).toHaveBeenCalledOnce()
		expect(approvalMessages[0]).toMatchObject({ isOutsideWorkspace: true, content: external })
		expect(result).toContain("Denied by user")
		expect(result).not.toContain("synthetic external secret")
		expect(fs.open).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("blocks an ignored canonical target before approval or content I/O", async () => {
		const ignored = path.join(workspace, "ignored.txt")
		await fs.writeFile(ignored, "ignored secret")
		await fs.symlink(ignored, path.join(workspace, "alias.txt"))
		task.rooIgnoreController.validateAccess.mockImplementation((file) => file !== ignored)

		const result = await read({ path: "alias.txt" })

		expect(result).not.toContain("ignored secret")
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.say).toHaveBeenCalledWith("rooignore_error", "alias.txt")
		expect(fs.open).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it("rejects a regular-file replacement during approval without disclosing replacement bytes", async () => {
		manualApproval.mockImplementation(async () => {
			await fs.rename(external, `${external}.original`)
			await fs.writeFile(external, "unapproved replacement secret")
			return { response: "yesButtonClicked" }
		})

		const result = await read({ path: external })

		expect(result).not.toContain("unapproved replacement secret")
		expect(result).toContain("File target changed after approval")
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("rejects a different device even when the approved inode is unchanged", async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const otherDeviceStats = await actual.lstat(external, { bigint: true })
		otherDeviceStats.dev += 1n
		manualApproval.mockResolvedValue({ response: "yesButtonClicked" })
		await inspectOpenedFile((file) => {
			vi.spyOn(file, "stat").mockResolvedValueOnce(otherDeviceStats)
			vi.spyOn(file, "read")
			vi.spyOn(file, "readFile")
		})

		const result = await read({ path: external })

		expect(manualApproval).toHaveBeenCalledOnce()
		expect(result).toContain("File target changed after approval")
		expect(result).not.toContain("synthetic external secret")
		expect(openedFiles[0].read).not.toHaveBeenCalled()
		expect(openedFiles[0].readFile).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("legacy requires external target approval and retains its string result", async () => {
		await fs.symlink(external, path.join(workspace, "linked.txt"))

		const result = await read({ files: [{ path: "linked.txt" }], _legacyFormat: true })

		expect(manualApproval).toHaveBeenCalledOnce()
		expect(approvalMessages[0]).toMatchObject({ isOutsideWorkspace: true, content: external })
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("File: linked.txt\nStatus: Denied by user")
		expect(result).not.toContain("synthetic external secret")
	})

	it("legacy rejects canonical symlink substitution during approval", async () => {
		const replacement = path.join(directory, "unapproved.txt")
		await fs.writeFile(replacement, "legacy replacement secret")
		manualApproval.mockImplementation(async () => {
			await fs.rename(external, `${external}.original`)
			await fs.symlink(replacement, external)
			return { response: "yesButtonClicked" }
		})

		const result = await read({ files: [{ path: external }], _legacyFormat: true })

		expect(result).not.toContain("legacy replacement secret")
		expect(result).toContain("Error:")
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("images use only approved descriptor bytes after filename replacement", async () => {
		const image = path.join(workspace, "image.png")
		const replacement = path.join(directory, "other.png")
		const approved = Buffer.from([137, 80, 78, 71, 0, 1, 2, 3])
		const unapproved = Buffer.from([137, 80, 78, 71, 0, 9, 8, 7])
		await fs.writeFile(image, approved)
		await fs.writeFile(replacement, unapproved)
		await replaceAfterOpening(image, replacement)

		const result = await read({ path: "image.png" })

		expect(result).toContain(approved.toString("base64"))
		expect(result).not.toContain(unapproved.toString("base64"))
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it("XLSX extraction preserves formatting and consumes approved bytes after filename replacement", async () => {
		const spreadsheet = path.join(workspace, "book.xlsx")
		const replacement = path.join(directory, "other.xlsx")
		for (const [file, value] of [
			[spreadsheet, "approved cell"],
			[replacement, "unapproved cell"],
		]) {
			const workbook = new ExcelJS.Workbook()
			workbook.addWorksheet("Data").getCell("A1").value = value
			await workbook.xlsx.writeFile(file)
		}
		await replaceAfterOpening(spreadsheet, replacement)

		const result = await read({ path: "book.xlsx" })

		expect(result).toContain("1 | --- Sheet: Data ---")
		expect(result).toContain("2 | approved cell")
		expect(result).not.toContain("unapproved cell")
	})

	it("notebook extraction uses approved bytes without changing historical line numbering", async () => {
		const notebook = path.join(workspace, "book.ipynb")
		const replacement = path.join(directory, "other.ipynb")
		for (const [file, value] of [
			[notebook, "approved code"],
			[replacement, "unapproved code"],
		]) {
			await fs.writeFile(file, JSON.stringify({ cells: [{ cell_type: "code", source: [value] }] }))
		}
		await replaceAfterOpening(notebook, replacement)
		// The old reader extracts notebooks only when binary detection chooses that branch.
		vi.mocked(isBinaryFile).mockResolvedValue(true)

		const result = await read({ path: "book.ipynb" })

		expect(result).toContain("1 | 1 | approved code")
		expect(result).not.toContain("unapproved code")
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it("PDF decoding consumes approved bytes after filename replacement", async () => {
		const document = path.join(workspace, "document.pdf")
		const replacement = path.join(directory, "other.pdf")
		await fs.writeFile(document, "approved PDF text")
		await fs.writeFile(replacement, "unapproved PDF text")
		await replaceAfterOpening(document, replacement)
		vi.mocked(isBinaryFile).mockResolvedValue(true)

		const result = await read({ path: "document.pdf" })

		expect(result).toContain("1 | 1 | approved PDF text")
		expect(result).not.toContain("unapproved PDF text")
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it("DOCX decoding consumes approved bytes after filename replacement", async () => {
		const document = path.join(workspace, "document.docx")
		const replacement = path.join(directory, "other.docx")
		await fs.writeFile(document, "approved DOCX text")
		await fs.writeFile(replacement, "unapproved DOCX text")
		await replaceAfterOpening(document, replacement)
		vi.mocked(isBinaryFile).mockResolvedValue(true)

		const result = await read({ path: "document.docx" })

		expect(result).toContain("1 | 1 | approved DOCX text")
		expect(result).not.toContain("unapproved DOCX text")
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it("reads the original canonical target when the requested alias changes during approval", async () => {
		const alias = path.join(workspace, "alias.txt")
		const replacement = path.join(directory, "replacement.txt")
		await fs.writeFile(replacement, "unapproved alias bytes")
		await fs.symlink(external, alias)
		manualApproval.mockImplementation(async () => {
			await fs.unlink(alias)
			await fs.symlink(replacement, alias)
			return { response: "yesButtonClicked" }
		})

		const result = await read({ path: "alias.txt" })

		expect(result).toContain("1 | synthetic external secret")
		expect(result).not.toContain("unapproved alias bytes")
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it.each(["final symlink", "parent symlink", "legacy regular file"])(
		"rejects approved identity replacement: %s",
		async (kind) => {
			const parent = path.join(directory, "approved")
			const other = path.join(directory, "other")
			await fs.mkdir(parent)
			await fs.mkdir(other)
			const approved = path.join(parent, "file.txt")
			await fs.writeFile(approved, "approved bytes")
			await fs.writeFile(path.join(other, "file.txt"), "unapproved bytes")
			manualApproval.mockImplementation(async () => {
				if (kind === "parent symlink") {
					await fs.rename(parent, `${parent}.original`)
					await fs.symlink(other, parent)
				} else {
					await fs.rename(approved, `${approved}.original`)
					if (kind === "final symlink") await fs.symlink(path.join(other, "file.txt"), approved)
					else await fs.writeFile(approved, "unapproved bytes")
				}
				return { response: "yesButtonClicked" }
			})

			const result = await read(
				kind === "legacy regular file"
					? { files: [{ path: approved }], _legacyFormat: true }
					: { path: approved },
			)

			expect(result).not.toContain("unapproved bytes")
			expect(result).toContain("Error:")
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		},
	)

	it("a symlinked workspace root remains internal under the real approval policy", async () => {
		const rootAlias = path.join(directory, "root-alias")
		await fs.symlink(workspace, rootAlias)
		await fs.writeFile(path.join(workspace, "internal.txt"), "first line\nsecond line")
		vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue([
			{ uri: vscode.Uri.file(rootAlias), name: "alias", index: 0 },
		])
		task.cwd = rootAlias

		await read({ path: "internal.txt" })

		expect(manualApproval).not.toHaveBeenCalled()
		expect(approvalMessages[0]).toMatchObject({ isOutsideWorkspace: false })
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("File: internal.txt\n1 | first line\n2 | second line")
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it.each(
		(["relative", "alias-absolute", "canonical-absolute"] as const).flatMap((spelling) =>
			[false, true].map((legacy) => ({ spelling, legacy })),
		),
	)(
		"auto-approves a canonical internal target with $spelling allowlist (legacy=$legacy)",
		async ({ spelling, legacy }) => {
			const rootAlias = path.join(directory, "root-alias")
			await fs.symlink(workspace, rootAlias)
			await fs.mkdir(path.join(workspace, "docs"))
			const canonicalFile = path.join(workspace, "docs", "notes.md")
			await fs.writeFile(canonicalFile, "allowed internal bytes")
			const pattern =
				spelling === "relative" ? "docs/**" : `${spelling === "alias-absolute" ? rootAlias : workspace}/docs/**`
			task = createTask({ alwaysAllowReadOnly: false, allowedReadFiles: [pattern] })
			task.cwd = rootAlias

			const result = await read(
				legacy ? { files: [{ path: "docs/notes.md" }], _legacyFormat: true } : { path: "docs/notes.md" },
			)

			expect(manualApproval).not.toHaveBeenCalled()
			expect(approvalMessages[0]).toMatchObject({
				path: canonicalFile,
				content: canonicalFile,
				isOutsideWorkspace: false,
			})
			expect(result).toContain("1 | allowed internal bytes")
			expect(fs.readFile).not.toHaveBeenCalled()
		},
	)

	it.each([false, true])(
		"an external file symlink needs an explicit external pattern (explicit=%s)",
		async (explicit) => {
			const rootAlias = path.join(directory, "root-alias")
			await fs.symlink(workspace, rootAlias)
			await fs.mkdir(path.join(workspace, "docs"))
			await fs.symlink(external, path.join(workspace, "docs", "alias.md"))
			task = createTask({
				alwaysAllowReadOnly: false,
				allowedReadFiles: explicit ? ["docs/**", external] : ["docs/**"],
			})
			task.cwd = rootAlias

			const result = await read({ path: "docs/alias.md" })

			expect(approvalMessages[0]).toMatchObject({ path: external, content: external, isOutsideWorkspace: true })
			if (explicit) {
				expect(manualApproval).not.toHaveBeenCalled()
				expect(result).toContain("1 | synthetic external secret")
			} else {
				expect(manualApproval).toHaveBeenCalledOnce()
				expect(result).toContain("Denied by user")
				expect(result).not.toContain("synthetic external secret")
				expect(fs.open).not.toHaveBeenCalled()
			}
			expect(fs.readFile).not.toHaveBeenCalled()
		},
	)

	it("uses the task root rather than the first workspace folder for multi-root read matching", async () => {
		const focusedRoot = path.join(directory, "focused-workspace")
		const rootAlias = path.join(directory, "task-alias")
		await fs.mkdir(focusedRoot)
		await fs.symlink(workspace, rootAlias)
		await fs.writeFile(path.join(workspace, "notes.md"), "task-local bytes")
		vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue([
			{ uri: vscode.Uri.file(focusedRoot), name: "focused", index: 0 },
			{ uri: vscode.Uri.file(rootAlias), name: "task", index: 1 },
		])
		task = createTask({ alwaysAllowReadOnly: false, allowedReadFiles: ["notes.md"] })
		task.cwd = rootAlias

		const result = await read({ path: "notes.md" })

		expect(manualApproval).not.toHaveBeenCalled()
		expect(approvalMessages[0]).toMatchObject({
			isOutsideWorkspace: false,
			content: path.join(workspace, "notes.md"),
		})
		expect(result).toContain("1 | task-local bytes")
	})

	it("does not apply a task-relative allowlist to another open workspace root", async () => {
		const otherRoot = path.join(directory, "other-workspace")
		const rootAlias = path.join(directory, "task-alias")
		await fs.mkdir(otherRoot)
		await fs.symlink(workspace, rootAlias)
		const otherFile = path.join(otherRoot, "notes.md")
		await fs.writeFile(otherFile, "unapproved other-root bytes")
		vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue([
			{ uri: vscode.Uri.file(otherRoot), name: "other", index: 0 },
			{ uri: vscode.Uri.file(rootAlias), name: "task", index: 1 },
		])
		task = createTask({ alwaysAllowReadOnly: false, allowedReadFiles: ["notes.md"] })
		task.cwd = rootAlias

		const result = await read({ path: otherFile })

		expect(manualApproval).toHaveBeenCalledOnce()
		expect(approvalMessages[0]).toMatchObject({ path: otherFile, content: otherFile, isOutsideWorkspace: false })
		expect(result).toContain("Denied by user")
		expect(result).not.toContain("unapproved other-root bytes")
		expect(fs.open).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it.each(["absent", "unresolvable", "sibling"])(
		"does not grant blanket internal permission with %s workspace containment",
		async (kind) => {
			const sibling = `${workspace}-sibling`
			await fs.mkdir(sibling)
			const filePath = path.join(kind === "sibling" ? sibling : workspace, "notes.md")
			await fs.writeFile(filePath, "unapproved containment bytes")
			vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue(
				kind === "absent"
					? undefined
					: [
							{
								uri: vscode.Uri.file(
									kind === "unresolvable" ? path.join(directory, "missing-root") : workspace,
								),
								name: "root",
								index: 0,
							},
						],
			)

			const result = await read({ path: filePath })

			expect(manualApproval).toHaveBeenCalledOnce()
			expect(approvalMessages[0]).toMatchObject({ isOutsideWorkspace: true, content: filePath })
			expect(result).toContain("Denied by user")
			expect(result).not.toContain("unapproved containment bytes")
			expect(fs.open).not.toHaveBeenCalled()
			expect(fs.readFile).not.toHaveBeenCalled()
		},
	)

	it("does not disclose an existing external file through ENOTDIR when approval is denied", async () => {
		const invalidChild = path.join(external, "child.txt")
		manualApproval.mockImplementation(async () => {
			expect(task.say).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(fs.open).not.toHaveBeenCalled()
			expect(fs.readFile).not.toHaveBeenCalled()
			return { response: "noButtonClicked" }
		})

		const result = await read({ path: invalidChild })

		expect(manualApproval).toHaveBeenCalledOnce()
		expect(approvalMessages[0]).toMatchObject({ isOutsideWorkspace: true, content: invalidChild })
		expect(result).toContain("Denied by user")
		expect(result).not.toContain("ENOTDIR")
		expect(fs.open).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it.each(
		["ENOTDIR", "EACCES", "ELOOP"].flatMap((code) =>
			(["realpath", "lstat"] as const).flatMap((operation) =>
				[false, true].flatMap((legacy) =>
					[false, true].map((approved) => ({ code, operation, legacy, approved })),
				),
			),
		),
	)(
		"defers $operation $code diagnostics (legacy=$legacy, approved=$approved)",
		async ({ code, operation, legacy, approved }) => {
			const lexicalPath = path.join(directory, "outside-alias.txt")
			await fs.symlink(external, lexicalPath)
			vi.mocked(fs[operation]).mockRejectedValueOnce(
				Object.assign(new Error(`${code}: resolution inaccessible`), { code }),
			)
			manualApproval.mockImplementation(async () => {
				expect(task.say).not.toHaveBeenCalled()
				expect(callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(fs.open).not.toHaveBeenCalled()
				expect(fs.readFile).not.toHaveBeenCalled()
				return { response: approved ? "yesButtonClicked" : "noButtonClicked" }
			})

			const result = await read(
				legacy ? { files: [{ path: lexicalPath }], _legacyFormat: true } : { path: lexicalPath },
			)

			expect(manualApproval).toHaveBeenCalledOnce()
			expect(approvalMessages[0]).toMatchObject({ isOutsideWorkspace: true, content: lexicalPath })
			if (approved) expect(result).toContain(`${code}: resolution inaccessible`)
			else {
				expect(result).toContain("Denied by user")
				expect(result).not.toContain(code)
			}
			expect(task.didToolFailInCurrentTurn).toBe(approved)
			expect(fs.open).not.toHaveBeenCalled()
			expect(fs.readFile).not.toHaveBeenCalled()
			expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		},
	)

	it.each([undefined, 123])(
		"does not defer unexpected resolution errors with a non-string errno (%s)",
		async (code) => {
			vi.mocked(fs.realpath).mockRejectedValueOnce(
				Object.assign(new TypeError("unexpected resolution failure"), { code }),
			)

			const result = await read({ path: external })

			expect(result).toContain("unexpected resolution failure")
			expect(task.ask).not.toHaveBeenCalled()
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(fs.open).not.toHaveBeenCalled()
			expect(fs.readFile).not.toHaveBeenCalled()
		},
	)

	it.each([false, true])("missing-file diagnostics stay after approval (legacy=%s)", async (legacy) => {
		const missing = path.join(directory, "missing.txt")
		manualApproval.mockImplementation(async () => {
			expect(task.say).not.toHaveBeenCalled()
			expect(fs.open).not.toHaveBeenCalled()
			return { response: "yesButtonClicked" }
		})

		const result = await read(legacy ? { files: [{ path: missing }], _legacyFormat: true } : { path: missing })

		expect(manualApproval).toHaveBeenCalledOnce()
		expect(result).toContain("ENOENT")
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("pre-aborted ordinary reads start no access UI, approval or filesystem work", async () => {
		task.abort = true

		const result = await read({ path: external })

		expect(task.rooIgnoreController.validateAccess).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
		expect(result).not.toContain("synthetic external secret")
		expect(task.didRejectTool).toBe(false)
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it("abandonment while realpath is pending stops identity capture without error UI", async () => {
		const started = deferred<void>()
		const resolved = deferred<string>()
		vi.mocked(fs.realpath).mockImplementationOnce(() => {
			started.resolve()
			return resolved.promise
		})
		const pending = read({ path: external })
		await started.promise
		task.abandoned = true
		resolved.resolve(external)

		await pending

		expect(fs.lstat).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it("abort during identity capture prevents canonical revalidation and target access", async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const identity = await actual.lstat(external, { bigint: true })
		const started = deferred<void>()
		const release = deferred<void>()
		vi.mocked(fs.realpath).mockClear()
		vi.mocked(fs.lstat).mockImplementationOnce(async () => {
			started.resolve()
			await release.promise
			return identity
		})
		const pending = read({ path: external })
		await started.promise
		task.abort = true
		release.resolve()
		await pending

		expect(fs.realpath).toHaveBeenCalledOnce()
		expect(task.rooIgnoreController.validateAccess).toHaveBeenCalledOnce()
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("abort during final canonical revalidation prevents resolved-target access", async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const started = deferred<void>()
		const release = deferred<void>()
		vi.mocked(fs.realpath)
			.mockImplementationOnce(actual.realpath)
			.mockImplementationOnce(async () => {
				started.resolve()
				await release.promise
				return external
			})
		const pending = read({ path: external })
		await started.promise
		task.abort = true
		release.resolve()
		await pending

		expect(task.rooIgnoreController.validateAccess).toHaveBeenCalledOnce()
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("abort during workspace classification does not start approval", async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const started = deferred<void>()
		const release = deferred<void>()
		vi.mocked(fs.realpath).mockImplementation(async (...args) => {
			if (args[0] === workspace) {
				started.resolve()
				await release.promise
			}
			return actual.realpath(...args)
		})
		const pending = read({ path: external })
		await started.promise
		task.abort = true
		release.resolve()
		await pending

		expect(task.ask).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(task.didRejectTool).toBe(false)
	})

	it("late denied approval retains received feedback but does not become a rejection after cancellation", async () => {
		const started = deferred<void>()
		const approval = deferred<Awaited<ReturnType<Task["ask"]>>>()
		task.ask.mockImplementationOnce(() => {
			started.resolve()
			return approval.promise
		})
		const pending = read({ path: external })
		await started.promise
		task.abandoned = true
		approval.resolve({
			response: "noButtonClicked",
			text: "Inspect only",
			images: ["data:image/png;base64,aW1hZ2U="],
		})
		const result = await pending

		expect(task.didRejectTool).toBe(false)
		expect(task.didToolFailInCurrentTurn).toBe(false)
		expect(task.say).not.toHaveBeenCalled()
		expect(result).toContain("Inspect only")
		expect(result).toContain("aW1hZ2U=")
		expect(result).not.toContain("Denied by user")
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("a descriptor opened after abort closes without starting metadata or content I/O", async () => {
		manualApproval.mockResolvedValue({ response: "yesButtonClicked" })
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const started = deferred<fs.FileHandle>()
		const release = deferred<void>()
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await actual.open(...args)
			openedFiles.push(file)
			vi.spyOn(file, "stat")
			vi.spyOn(file, "read")
			vi.spyOn(file, "readFile")
			started.resolve(file)
			await release.promise
			return file
		})
		const pending = read({ path: external })
		const file = await started.promise
		task.abort = true
		release.resolve()
		await pending

		expect(file.stat).not.toHaveBeenCalled()
		expect(file.read).not.toHaveBeenCalled()
		expect(file.readFile).not.toHaveBeenCalled()
		expect(file.fd).toBe(-1)
		expect(task.say).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it("abandonment during fstat stops the descriptor probe and closes the handle", async () => {
		manualApproval.mockResolvedValue({ response: "yesButtonClicked" })
		const started = deferred<fs.FileHandle>()
		const release = deferred<void>()
		await inspectOpenedFile((file) => {
			const stat = file.stat.bind(file)
			vi.spyOn(file, "stat").mockImplementationOnce(async (options) => {
				started.resolve(file)
				await release.promise
				return stat(options)
			})
			vi.spyOn(file, "read")
		})
		const pending = read({ path: external })
		const file = await started.promise
		task.abandoned = true
		release.resolve()
		await pending

		expect(file.read).not.toHaveBeenCalled()
		expect(file.fd).toBe(-1)
		expect(task.say).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it("abort during the descriptor probe prevents binary detection", async () => {
		manualApproval.mockResolvedValue({ response: "yesButtonClicked" })
		const started = deferred<void>()
		const release = deferred<void>()
		await inspectOpenedFile((file) => {
			vi.spyOn(file, "read").mockImplementationOnce(async () => {
				started.resolve()
				await release.promise
				return { bytesRead: 0, buffer: Buffer.alloc(0) }
			})
		})
		const pending = read({ path: external })
		await started.promise
		task.abort = true
		release.resolve()
		await pending

		expect(isBinaryFile).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("abandonment during binary detection prevents whole-file I/O", async () => {
		manualApproval.mockResolvedValue({ response: "yesButtonClicked" })
		const started = deferred<void>()
		const detected = deferred<boolean>()
		await inspectOpenedFile((file) => {
			vi.spyOn(file, "readFile")
		})
		vi.mocked(isBinaryFile).mockImplementationOnce(() => {
			started.resolve()
			return detected.promise
		})
		const pending = read({ path: external })
		await started.promise
		task.abandoned = true
		detected.resolve(false)
		await pending

		expect(openedFiles[0].readFile).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("late ordinary text bytes are not decoded or tracked after abandonment", async () => {
		manualApproval.mockResolvedValue({ response: "yesButtonClicked" })
		const started = deferred<void>()
		const buffer = Buffer.from("late text secret")
		const bytes = deferred<typeof buffer>()
		const decode = vi.spyOn(buffer, "toString")
		await inspectOpenedFile((file) => {
			vi.spyOn(file, "readFile").mockImplementationOnce(() => {
				started.resolve()
				return bytes.promise
			})
		})
		const pending = read({ path: external })
		await started.promise
		task.abandoned = true
		bytes.resolve(buffer)
		const result = await pending

		expect(decode).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(result).not.toContain("late text secret")
	})

	it("document bytes arriving after abort do not start extraction", async () => {
		const document = path.join(workspace, "late.docx")
		await fs.writeFile(document, "approved document")
		vi.mocked(isBinaryFile).mockResolvedValue(true)
		const extract = vi.spyOn(mammoth, "extractRawText")
		const started = deferred<void>()
		const buffer = Buffer.from("late document secret")
		const bytes = deferred<typeof buffer>()
		await inspectOpenedFile((file) => {
			vi.spyOn(file, "readFile").mockImplementationOnce(() => {
				started.resolve()
				return bytes.promise
			})
		})
		const pending = read({ path: "late.docx" })
		await started.promise
		task.abort = true
		bytes.resolve(buffer)
		const result = await pending

		expect(extract).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(result).not.toContain("late document secret")
	})

	it("late extraction output is discarded without starting context tracking", async () => {
		await fs.writeFile(path.join(workspace, "late.docx"), "approved document")
		vi.mocked(isBinaryFile).mockResolvedValue(true)
		const started = deferred<void>()
		const extraction = deferred<Awaited<ReturnType<typeof mammoth.extractRawText>>>()
		vi.spyOn(mammoth, "extractRawText").mockImplementationOnce(() => {
			started.resolve()
			return extraction.promise
		})
		const pending = read({ path: "late.docx" })
		await started.promise
		task.abandoned = true
		extraction.resolve({ value: "late extraction secret", messages: [] })
		const result = await pending

		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(result).not.toContain("late extraction secret")
	})

	it.each([2, 3])("abort during image metadata step %s prevents image byte reads", async (step) => {
		await fs.writeFile(path.join(workspace, "image.png"), Buffer.from([137, 80, 78, 71, 0]))
		const started = deferred<void>()
		const release = deferred<void>()
		await inspectOpenedFile((file) => {
			const stat = file.stat.bind(file)
			let calls = 0
			vi.spyOn(file, "stat").mockImplementation(async (options) => {
				if (++calls === step) {
					started.resolve()
					await release.promise
				}
				return stat(options)
			})
			vi.spyOn(file, "readFile")
		})
		const pending = read({ path: "image.png" })
		await started.promise
		task.abort = true
		release.resolve()
		await pending

		expect(openedFiles[0].readFile).not.toHaveBeenCalled()
		expect(openedFiles[0].stat).toHaveBeenCalledTimes(step)
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it("image bytes arriving after abort are not base64 encoded or tracked", async () => {
		await fs.writeFile(path.join(workspace, "image.png"), Buffer.from([137, 80, 78, 71, 0]))
		const started = deferred<void>()
		const buffer = Buffer.from([137, 80, 78, 71, 0, 9])
		const bytes = deferred<typeof buffer>()
		const encode = vi.spyOn(buffer, "toString")
		await inspectOpenedFile((file) => {
			vi.spyOn(file, "readFile").mockImplementationOnce(() => {
				started.resolve()
				return bytes.promise
			})
		})
		const pending = read({ path: "image.png" })
		await started.promise
		task.abort = true
		bytes.resolve(buffer)
		await pending

		expect(encode).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("processed images arriving after abandonment do not start context tracking", async () => {
		await fs.writeFile(path.join(workspace, "image.png"), Buffer.from([137, 80, 78, 71, 0]))
		const started = deferred<void>()
		const image = deferred<imageHelpers.ImageProcessingResult>()
		vi.spyOn(imageHelpers, "processImageFile").mockImplementationOnce(() => {
			started.resolve()
			return image.promise
		})
		const pending = read({ path: "image.png" })
		await started.promise
		task.abandoned = true
		image.resolve({
			dataUrl: "data:image/png;base64,bGF0ZQ==",
			buffer: Buffer.from("late"),
			sizeInKB: 1,
			sizeInMB: 0.001,
			notice: "late image",
		})
		const result = await pending

		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(result).not.toContain("bGF0ZQ==")
		expect(task.say).not.toHaveBeenCalled()
	})

	it("cancellation during an already-started diagnostic retains approval feedback without marking failure", async () => {
		task.ask.mockResolvedValueOnce({ response: "yesButtonClicked", text: "Inspect only" })
		vi.mocked(fs.open).mockRejectedValueOnce(new Error("read diagnostic"))
		const started = deferred<void>()
		const release = deferred<void>()
		task.say.mockImplementation(async (type) => {
			if (type === "error") {
				started.resolve()
				await release.promise
			}
		})
		const pending = read({ path: external })
		await started.promise
		task.abort = true
		release.resolve()
		const result = await pending

		expect(task.didToolFailInCurrentTurn).toBe(false)
		expect(task.didRejectTool).toBe(false)
		expect(result).toContain("Inspect only")
		expect(result).not.toContain("read diagnostic")
	})

	it.each([false, true])("abort during the outer diagnostic does not publish failure (reject=%s)", async (reject) => {
		task.ask.mockRejectedValueOnce(new Error("approval technical failure"))
		const started = deferred<void>()
		const release = deferred<void>()
		task.say.mockImplementationOnce(async () => {
			started.resolve()
			await release.promise
		})
		const pending = read({ path: external })
		await started.promise
		task.abort = true
		if (reject) release.reject(new Error("late diagnostic rejection"))
		else release.resolve()
		await pending

		expect(task.didToolFailInCurrentTurn).toBe(false)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it.each([false, true])(
		"handle reads pinned text after opening and preserves ranges (legacy=%s)",
		async (legacy) => {
			const file = path.join(workspace, "pinned.txt")
			const replacement = path.join(directory, "other.txt")
			await fs.writeFile(file, "first\nsecond\nthird")
			await fs.writeFile(replacement, "unapproved replacement text")
			await replaceAfterOpening(file, replacement)
			// This host double intentionally omits Task members unrelated to file reading.
			await readFileTool.handle(
				task as unknown as Task,
				{
					type: "tool_use",
					name: "read_file",
					params: {},
					partial: false,
					nativeArgs: legacy
						? { files: [{ path: "pinned.txt", lineRanges: [{ start: 2, end: 3 }] }], _legacyFormat: true }
						: { path: "pinned.txt", offset: 2, limit: 2 },
				},
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith("File: pinned.txt\n2 | second\n3 | third")
			expect(fs.readFile).not.toHaveBeenCalled()
			expect(task.didToolFailInCurrentTurn).toBe(false)
		},
	)

	it.each(["approval", "realpath", "fstat", "text", "image", "document", "tracking", "close"])(
		"late rejection at %s is suppressed after cancellation and descriptors are released",
		async (boundary) => {
			const started = deferred<void>()
			const failure = deferred<never>()
			const fail = () => {
				started.resolve()
				return failure.promise
			}
			const filePath = boundary === "image" ? "late.png" : boundary === "document" ? "late.docx" : external
			if (filePath !== external) await fs.writeFile(path.join(workspace, filePath), "approved bytes")
			task.ask.mockResolvedValueOnce({ response: "yesButtonClicked", text: "Inspect only" })
			if (boundary === "approval") task.ask.mockReset().mockImplementationOnce(fail)
			if (boundary === "realpath") vi.mocked(fs.realpath).mockImplementationOnce(fail)
			if (boundary === "image") {
				vi.mocked(isBinaryFile).mockResolvedValue(true)
				vi.spyOn(imageHelpers, "processImageFile").mockImplementationOnce(fail)
			}
			if (boundary === "document") {
				vi.mocked(isBinaryFile).mockResolvedValue(true)
				vi.spyOn(mammoth, "extractRawText").mockImplementationOnce(fail)
			}
			if (boundary === "tracking") task.fileContextTracker.trackFileContext.mockImplementationOnce(fail)
			await inspectOpenedFile((file) => {
				if (boundary === "fstat") vi.spyOn(file, "stat").mockImplementationOnce(fail)
				if (boundary === "text") vi.spyOn(file, "readFile").mockImplementationOnce(fail)
				if (boundary === "close") {
					const close = file.close.bind(file)
					vi.spyOn(file, "close").mockImplementationOnce(async () => {
						await close()
						return fail()
					})
				}
			})
			const pending = read({ path: filePath })
			await started.promise
			task.abort = true
			failure.reject(new Error("late technical rejection"))
			const result = await pending

			expect(task.didToolFailInCurrentTurn).toBe(false)
			expect(task.didRejectTool).toBe(false)
			expect(task.say.mock.calls.some(([type]) => type === "error")).toBe(false)
			expect(result).not.toContain("late technical rejection")
			if (boundary !== "approval" && boundary !== "realpath") expect(result).toContain("Inspect only")
		},
	)

	it.each(
		["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].flatMap((code) => [false, true].map((legacy) => ({ code, legacy }))),
	)("cancelled $code resolution does not start access or approval (legacy=$legacy)", async ({ code, legacy }) => {
		const started = deferred<void>()
		const resolution = deferred<never>()
		vi.mocked(fs.realpath).mockImplementationOnce(() => {
			started.resolve()
			return resolution.promise
		})
		const pending = read(legacy ? { files: [{ path: external }], _legacyFormat: true } : { path: external })
		await started.promise
		task.abort = true
		resolution.reject(Object.assign(new Error("resolution failed after cancellation"), { code }))
		await pending

		expect(fs.lstat).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it.each(["approved feedback", "denied feedback", "rejected feedback", "tracking", "closing"])(
		"cancellation during %s discards content while retaining received approval feedback",
		async (boundary) => {
			task.ask.mockResolvedValueOnce({
				response: boundary === "denied feedback" ? "noButtonClicked" : "yesButtonClicked",
				text: "Inspect only",
			})
			const started = deferred<void>()
			const release = deferred<void>()
			const wait = () => {
				started.resolve()
				return release.promise
			}
			if (boundary.includes("feedback"))
				task.say.mockImplementationOnce(async () => {
					await wait()
					return undefined
				})
			if (boundary === "tracking") task.fileContextTracker.trackFileContext.mockImplementationOnce(wait)
			if (boundary === "closing") {
				await inspectOpenedFile((file) => {
					const close = file.close.bind(file)
					vi.spyOn(file, "close").mockImplementationOnce(async () => {
						await wait()
						await close()
					})
				})
			}
			const pending = read({ path: external })
			await started.promise
			task.abort = true
			if (boundary === "rejected feedback") release.reject(new Error("late feedback rejection"))
			else release.resolve()
			const result = await pending

			expect(result).toContain("Inspect only")
			expect(result).not.toContain("synthetic external secret")
			expect(result).not.toContain("late feedback rejection")
			expect(task.didToolFailInCurrentTurn).toBe(false)
			expect(task.didRejectTool).toBe(false)
			if (boundary.includes("feedback")) expect(fs.open).not.toHaveBeenCalled()
		},
	)

	it.each([false, true])(
		"reports a parent retarget during identity capture before approval (legacy=%s)",
		async (legacy) => {
			const parent = path.join(directory, "parent")
			const replacement = path.join(directory, "replacement")
			await fs.mkdir(parent)
			await fs.mkdir(replacement)
			const file = path.join(parent, "file.txt")
			await fs.writeFile(file, "approved bytes")
			await fs.writeFile(path.join(replacement, "file.txt"), "unapproved parent bytes")
			const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			vi.mocked(fs.lstat).mockImplementationOnce(async (...args) => {
				await fs.rename(parent, `${parent}.original`)
				await fs.symlink(replacement, parent)
				return actual.lstat(...args)
			})

			const result = await read(legacy ? { files: [{ path: file }], _legacyFormat: true } : { path: file })

			expect(result).toContain("File target changed before approval")
			expect(result).not.toContain("unapproved parent bytes")
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(task.ask).not.toHaveBeenCalled()
			expect(fs.open).not.toHaveBeenCalled()
			expect(fs.readFile).not.toHaveBeenCalled()
		},
	)

	it("the real ignore controller blocks aliases to ignored internal files", async () => {
		await fs.writeFile(path.join(workspace, ".rooignore"), "ignored.txt\n")
		await fs.writeFile(path.join(workspace, "ignored.txt"), "ignored real secret")
		await fs.symlink(path.join(workspace, "ignored.txt"), path.join(workspace, "alias.txt"))
		const controller = new RooIgnoreController(workspace)
		try {
			await controller.initialize()
			vi.mocked(fs.readFile).mockClear()
			task.rooIgnoreController.validateAccess.mockImplementation((file) => controller.validateAccess(file))

			const result = await read({ path: "alias.txt" })

			expect(result).not.toContain("ignored real secret")
			expect(task.ask).not.toHaveBeenCalled()
			expect(fs.open).not.toHaveBeenCalled()
			expect(fs.readFile).not.toHaveBeenCalled()
		} finally {
			controller.dispose()
		}
	})

	it("failed real notebook extraction closes the descriptor and keeps uncancelled errors visible", async () => {
		await fs.writeFile(path.join(workspace, "invalid.ipynb"), "invalid notebook JSON")
		vi.mocked(isBinaryFile).mockResolvedValue(true)

		const result = await read({ path: "invalid.ipynb" })

		expect(result).toContain("Error:")
		expect(task.say.mock.calls.some(([type]) => type === "error")).toBe(true)
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(openedFiles).toHaveLength(1)
		expect(openedFiles[0].fd).toBe(-1)
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it("legacy binary probe failures retain the historical pinned text fallback", async () => {
		await fs.writeFile(path.join(workspace, "fallback.txt"), "fallback content")
		await inspectOpenedFile((file) => {
			vi.spyOn(file, "read").mockRejectedValueOnce(new Error("transient probe failure"))
		})

		await read({ files: [{ path: "fallback.txt" }], _legacyFormat: true })

		expect(callbacks.pushToolResult).toHaveBeenCalledWith("File: fallback.txt\n1 | fallback content")
		expect(task.didToolFailInCurrentTurn).toBe(false)
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it("cancelled approval retains received image-only feedback", async () => {
		const started = deferred<void>()
		const approval = deferred<Awaited<ReturnType<Task["ask"]>>>()
		task.ask.mockImplementationOnce(() => {
			started.resolve()
			return approval.promise
		})
		const pending = read({ path: external })
		await started.promise
		task.abort = true
		approval.resolve({ response: "yesButtonClicked", images: ["data:image/png;base64,dXNlciBmZWVkYmFjaw=="] })
		const result = await pending

		expect(result).toContain("dXNlciBmZWVkYmFjaw==")
		expect(result).not.toContain("synthetic external secret")
		expect(task.say).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("external approval remains pending without content I/O and then returns the approved bytes", async () => {
		const started = deferred<void>()
		const approval = deferred<Awaited<ReturnType<Task["ask"]>>>()
		manualApproval.mockImplementationOnce(() => {
			started.resolve()
			return approval.promise
		})
		const pending = read({ path: external })
		await started.promise

		expect(fs.open).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		approval.resolve({ response: "yesButtonClicked" })
		const result = await pending

		expect(result).toContain("1 | synthetic external secret")
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it("provider state arriving after abort does not start verified I/O or image processing", async () => {
		await fs.writeFile(path.join(workspace, "image.png"), Buffer.from([137, 80, 78, 71, 0]))
		const started = deferred<void>()
		const release = deferred<void>()
		task.providerRef.deref = () => ({
			getState: async () => {
				started.resolve()
				await release.promise
				return {}
			},
		})
		const validation = vi.spyOn(imageHelpers, "validateImageForProcessing")
		const pending = read({ path: "image.png" })
		await started.promise
		task.abort = true
		release.resolve()
		await pending

		expect(fs.open).not.toHaveBeenCalled()
		expect(validation).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})
})
