import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { isBinaryFile } from "isbinaryfile"
import type { Task } from "../../../task/Task"
import { ModernFileReader } from "../ModernFileReader"
import { ReadFileContentReader } from "../ReadFileContentReader"
import { ReadFileTextProcessor } from "../ReadFileTextProcessor"
import { ReadFileAccess } from "../ReadFileAccess"
import { ReadFileTarget } from "../ReadFileTarget"
import { extractRawTextFromFile } from "../../../../integrations/misc/extract-text"
import { processImageFile, validateImageForProcessing } from "../../helpers/imageHelpers"
import type { FileResult, ReadEntryOptions } from "../types"

// Instrument real filesystem calls; descriptors and their cleanup remain real.
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		realpath: vi.fn(actual.realpath),
		lstat: vi.fn(actual.lstat),
		open: vi.fn(actual.open),
	}
})

vi.mock("isbinaryfile", async (importOriginal) => {
	const actual = await importOriginal<typeof import("isbinaryfile")>()
	return { ...actual, isBinaryFile: vi.fn(actual.isBinaryFile) }
})

vi.mock("../../../../integrations/misc/extract-text", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../integrations/misc/extract-text")>()
	return { ...actual, extractRawTextFromFile: vi.fn(actual.extractRawTextFromFile) }
})

vi.mock("../../helpers/imageHelpers", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../helpers/imageHelpers")>()
	return {
		...actual,
		validateImageForProcessing: vi.fn(actual.validateImageForProcessing),
		processImageFile: vi.fn(actual.processImageFile),
	}
})

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve
		reject = onReject
	})
	return { promise, resolve, reject }
}

function createTask(cwd: string) {
	const getState = vi.fn(async () => ({ maxImageFileSize: 5, maxTotalImageSize: 20 }))
	return {
		cwd,
		abort: false,
		abandoned: false,
		didToolFailInCurrentTurn: false,
		didRejectTool: false,
		ask: vi.fn<Task["ask"]>().mockResolvedValue({ response: "yesButtonClicked" }),
		say: vi.fn<Task["say"]>().mockResolvedValue(undefined),
		rooIgnoreController: { validateAccess: vi.fn(() => true) },
		fileContextTracker: { trackFileContext: vi.fn(async () => {}) },
		api: { getModel: () => ({ info: { supportsImages: true } }) },
		providerRef: { deref: () => ({ getState }) },
	}
}

describe("ordinary read cancellation boundaries", () => {
	let directory: string
	let task: ReturnType<typeof createTask>

	function read(file = "source.txt", options: ReadEntryOptions = {}) {
		// This public-boundary host double omits Task members unrelated to file reading.
		return new ModernFileReader().read({ path: file }, task as unknown as Task, options)
	}

	beforeEach(async () => {
		vi.restoreAllMocks()
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.realpath).mockImplementation(actual.realpath)
		vi.mocked(fs.lstat).mockImplementation(actual.lstat)
		vi.mocked(fs.open).mockImplementation(actual.open)
		directory = await actual.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "zoo-read-cancel-")))
		await fs.writeFile(path.join(directory, "source.txt"), "ordinary content")
		task = createTask(directory)
		vi.clearAllMocks()
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("does no access UI, approval or filesystem work for a pre-aborted ordinary read", async () => {
		task.abort = true
		task.rooIgnoreController.validateAccess.mockReturnValue(false)

		expect(await read()).toEqual({ path: "source.txt", status: "cancelled" })
		expect(task.rooIgnoreController.validateAccess).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(fs.realpath).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("stops canonical inspection after realpath settles for an abandoned read", async () => {
		const canonical = deferred<string>()
		const started = deferred<void>()
		vi.mocked(fs.realpath).mockImplementationOnce(() => {
			started.resolve()
			return canonical.promise
		})
		const pending = read()
		await started.promise
		task.abandoned = true
		canonical.resolve(path.join(directory, "source.txt"))

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(fs.lstat).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("does not revalidate the canonical path after cancellation during identity capture", async () => {
		const identity = await fs.lstat(path.join(directory, "source.txt"), { bigint: true })
		const inspection = deferred<typeof identity>()
		const started = deferred<void>()
		vi.mocked(fs.lstat).mockImplementationOnce(() => {
			started.resolve()
			return inspection.promise
		})
		const pending = read()
		await started.promise
		task.abort = true
		inspection.resolve(identity)

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(fs.realpath).toHaveBeenCalledOnce()
		expect(task.ask).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("does not check target access when final canonical revalidation finishes after abort", async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const revalidation = deferred<string>()
		const started = deferred<void>()
		vi.mocked(fs.realpath).mockImplementation((...args) => {
			if (vi.mocked(fs.realpath).mock.calls.length === 2) {
				started.resolve()
				return revalidation.promise
			}
			return actual.realpath(...args)
		})
		const pending = read()
		await started.promise
		task.abort = true
		revalidation.resolve(path.join(directory, "source.txt"))

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(task.rooIgnoreController.validateAccess).toHaveBeenCalledExactlyOnceWith("source.txt")
		expect(task.ask).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("does not start approval after target access checking resolves for an abandoned task", async () => {
		const original = ReadFileAccess.prototype.check
		const access = deferred<FileResult | undefined>()
		const started = deferred<void>()
		vi.spyOn(ReadFileAccess.prototype, "check").mockImplementation(function (this: ReadFileAccess, relPath, host) {
			if (path.isAbsolute(relPath)) {
				started.resolve()
				return access.promise
			}
			return original.call(this, relPath, host)
		})
		const pending = read()
		await started.promise
		task.abandoned = true
		access.resolve(undefined)

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(task.ask).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("does not ask when workspace classification resolves after abort", async () => {
		const classification = deferred<boolean>()
		const started = deferred<void>()
		vi.spyOn(ReadFileTarget, "isOutsideWorkspace").mockImplementationOnce(() => {
			started.resolve()
			return classification.promise
		})
		const pending = read()
		await started.promise
		task.abort = true
		classification.resolve(false)

		expect(await pending).toEqual({ path: "source.txt", status: "cancelled" })
		expect(task.ask).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("closes a real descriptor opened after abort without starting fstat or content I/O", async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const opened = deferred<fs.FileHandle>()
		const release = deferred<void>()
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await actual.open(...args)
			opened.resolve(file)
			await release.promise
			return file
		})
		const pending = read()
		const file = await opened.promise
		const stat = vi.spyOn(file, "stat")
		const probe = vi.spyOn(file, "read")
		const load = vi.spyOn(file, "readFile")
		const close = vi.spyOn(file, "close")
		task.abort = true
		release.resolve()

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(stat).not.toHaveBeenCalled()
		expect(probe).not.toHaveBeenCalled()
		expect(load).not.toHaveBeenCalled()
		expect(close).toHaveBeenCalledOnce()
		expect(file.fd).toBe(-1)
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("does not detect binary content after the descriptor probe settles for an abandoned read", async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const started = deferred<void>()
		const release = deferred<void>()
		const opened = deferred<fs.FileHandle>()
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await actual.open(...args)
			const probe = file.read.bind(file)
			vi.spyOn(file, "read").mockImplementationOnce(async (...readArgs) => {
				const result = await probe(...readArgs)
				started.resolve()
				await release.promise
				return result
			})
			opened.resolve(file)
			return file
		})
		const pending = read()
		await started.promise
		task.abandoned = true
		release.resolve()

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(isBinaryFile).not.toHaveBeenCalled()
		expect((await opened.promise).fd).toBe(-1)
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("does not start ordinary document extraction after descriptor bytes arrive following abort", async () => {
		await fs.writeFile(
			path.join(directory, "document.ipynb"),
			JSON.stringify({ cells: [{ cell_type: "code", source: ["document content"] }] }),
		)
		vi.mocked(isBinaryFile).mockResolvedValueOnce(true)
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const started = deferred<void>()
		const release = deferred<void>()
		const opened = deferred<fs.FileHandle>()
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await actual.open(...args)
			const load = file.readFile.bind(file)
			vi.spyOn(file, "readFile").mockImplementationOnce(async (...readArgs) => {
				const bytes = await load(...readArgs)
				started.resolve()
				await release.promise
				return bytes
			})
			opened.resolve(file)
			return file
		})
		const pending = read("document.ipynb")
		await started.promise
		task.abort = true
		release.resolve()

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(extractRawTextFromFile).not.toHaveBeenCalled()
		expect((await opened.promise).fd).toBe(-1)
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("does not start text-only extraction after document bytes arrive following abandonment", async () => {
		await fs.writeFile(
			path.join(directory, "document.ipynb"),
			JSON.stringify({ cells: [{ cell_type: "code", source: ["document content"] }] }),
		)
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const started = deferred<void>()
		const release = deferred<void>()
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await actual.open(...args)
			const load = file.readFile.bind(file)
			vi.spyOn(file, "readFile").mockImplementationOnce(async (...readArgs) => {
				const bytes = await load(...readArgs)
				started.resolve()
				await release.promise
				return bytes
			})
			return file
		})
		const pending = read("document.ipynb", { textOnly: true })
		await started.promise
		task.abandoned = true
		release.resolve()

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(extractRawTextFromFile).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("does not validate or process an image after provider state arrives following abort", async () => {
		await fs.writeFile(path.join(directory, "image.png"), Buffer.from([137, 80, 78, 71, 0]))
		const getState = task.providerRef.deref().getState
		const state = deferred<Awaited<ReturnType<typeof getState>>>()
		const started = deferred<void>()
		getState.mockImplementationOnce(() => {
			started.resolve()
			return state.promise
		})
		const pending = read("image.png")
		await started.promise
		task.abort = true
		state.resolve({ maxImageFileSize: 5, maxTotalImageSize: 20 })

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(validateImageForProcessing).not.toHaveBeenCalled()
		expect(processImageFile).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("discards a processed image arriving after abandonment without registering context", async () => {
		await fs.writeFile(path.join(directory, "image.png"), Buffer.from([137, 80, 78, 71, 0]))
		const processing = deferred<Awaited<ReturnType<typeof processImageFile>>>()
		const started = deferred<void>()
		vi.mocked(processImageFile).mockImplementationOnce(() => {
			started.resolve()
			return processing.promise
		})
		const pending = read("image.png")
		await started.promise
		task.abandoned = true
		processing.resolve({
			dataUrl: "data:image/png;base64,bGF0ZQ==",
			buffer: Buffer.from("late"),
			sizeInKB: 1,
			sizeInMB: 0.001,
			notice: "late image",
		})

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("does not publish an error when pending image processing rejects after abort", async () => {
		await fs.writeFile(path.join(directory, "image.png"), Buffer.from([137, 80, 78, 71, 0]))
		const processing = deferred<Awaited<ReturnType<typeof processImageFile>>>()
		const started = deferred<void>()
		vi.mocked(processImageFile).mockImplementationOnce(() => {
			started.resolve()
			return processing.promise
		})
		const pending = read("image.png")
		await started.promise
		task.abort = true
		processing.reject(new Error("late processing failure"))

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(task.say).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(false)
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("does not load image bytes after processing metadata settles following abandonment", async () => {
		await fs.writeFile(path.join(directory, "image.png"), Buffer.from([137, 80, 78, 71, 0]))
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const started = deferred<void>()
		const release = deferred<void>()
		const opened = deferred<fs.FileHandle>()
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await actual.open(...args)
			const inspect = file.stat.bind(file)
			const stat = vi.spyOn(file, "stat").mockImplementation(async (...statArgs) => {
				const result = await inspect(...statArgs)
				// B1 identity inspection, image validation, then processing metadata.
				if (stat.mock.calls.length === 3) {
					started.resolve()
					await release.promise
				}
				return result
			})
			vi.spyOn(file, "readFile")
			opened.resolve(file)
			return file
		})
		const pending = read("image.png")
		await started.promise
		task.abandoned = true
		release.resolve()

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect((await opened.promise).readFile).not.toHaveBeenCalled()
		expect((await opened.promise).fd).toBe(-1)
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("does not base64-encode image bytes arriving after abort", async () => {
		const bytes = Buffer.from([137, 80, 78, 71, 0])
		await fs.writeFile(path.join(directory, "image.png"), bytes)
		const encode = vi.spyOn(bytes, "toString")
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const started = deferred<void>()
		const release = deferred<void>()
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await actual.open(...args)
			vi.spyOn(file, "readFile").mockImplementationOnce(async () => {
				started.resolve()
				await release.promise
				return bytes
			})
			return file
		})
		const pending = read("image.png")
		await started.promise
		task.abort = true
		release.resolve()

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(encode).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("discards read content after abort during descriptor closing but retains existing approval feedback", async () => {
		task.ask.mockResolvedValueOnce({
			response: "yesButtonClicked",
			text: "Inspect only",
			images: ["data:image/png;base64,aW1hZ2U="],
		})
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const started = deferred<void>()
		const release = deferred<void>()
		const opened = deferred<fs.FileHandle>()
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await actual.open(...args)
			const close = file.close.bind(file)
			vi.spyOn(file, "close").mockImplementationOnce(async () => {
				started.resolve()
				await release.promise
				await close()
			})
			opened.resolve(file)
			return file
		})
		const pending = read()
		await started.promise
		// Registration already started before cancellation; it cannot be rolled back.
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledOnce()
		task.abort = true
		release.resolve()

		const result = await pending
		expect(result).toMatchObject({
			status: "cancelled",
			feedbackText: "Inspect only",
			feedbackImages: ["data:image/png;base64,aW1hZ2U="],
		})
		expect(result.nativeContent).toBeUndefined()
		expect(result.imageDataUrl).toBeUndefined()
		expect((await opened.promise).fd).toBe(-1)
		expect(task.say).toHaveBeenCalledExactlyOnceWith("user_feedback", "Inspect only", [
			"data:image/png;base64,aW1hZ2U=",
		])
	})

	it("retains approval feedback if its already-started publication settles after abort", async () => {
		task.ask.mockResolvedValueOnce({ response: "yesButtonClicked", text: "Inspect only" })
		const publication = deferred<undefined>()
		const started = deferred<void>()
		task.say.mockImplementationOnce(() => {
			started.resolve()
			return publication.promise
		})
		const pending = read()
		await started.promise
		task.abort = true
		publication.resolve(undefined)

		expect(await pending).toMatchObject({ status: "cancelled", feedbackText: "Inspect only" })
		expect(fs.open).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("does not begin feedback publication for an approval arriving after abandonment", async () => {
		const approval = deferred<Awaited<ReturnType<Task["ask"]>>>()
		const started = deferred<void>()
		task.ask.mockImplementationOnce(() => {
			started.resolve()
			return approval.promise
		})
		const pending = read()
		await started.promise
		task.abandoned = true
		approval.resolve({ response: "yesButtonClicked", text: "Inspect only" })

		expect(await pending).toMatchObject({ status: "cancelled", feedbackText: "Inspect only" })
		expect(task.say).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("discards a late content-reader result at final delivery while retaining approval feedback", async () => {
		task.ask.mockResolvedValueOnce({ response: "yesButtonClicked", text: "Inspect only" })
		const content = deferred<FileResult>()
		const started = deferred<void>()
		vi.spyOn(ReadFileContentReader.prototype, "read").mockImplementationOnce(() => {
			started.resolve()
			return content.promise
		})
		const pending = read()
		await started.promise
		task.abandoned = true
		content.resolve({ path: "source.txt", status: "approved", nativeContent: "late content" })

		const result = await pending
		expect(result).toMatchObject({ status: "cancelled", feedbackText: "Inspect only" })
		expect(result.nativeContent).toBeUndefined()
	})

	it("retains approval feedback when the content reader rejects after abort", async () => {
		task.ask.mockResolvedValueOnce({ response: "yesButtonClicked", text: "Inspect only" })
		const content = deferred<FileResult>()
		const started = deferred<void>()
		vi.spyOn(ReadFileContentReader.prototype, "read").mockImplementationOnce(() => {
			started.resolve()
			return content.promise
		})
		const pending = read()
		await started.promise
		task.abort = true
		content.reject(new Error("late read failure"))

		expect(await pending).toMatchObject({ status: "cancelled", feedbackText: "Inspect only" })
		expect(task.say).toHaveBeenCalledExactlyOnceWith("user_feedback", "Inspect only", undefined)
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it("discards an error result if its already-started diagnostic settles after abort", async () => {
		vi.mocked(fs.realpath).mockRejectedValueOnce(new Error("canonical lookup failed"))
		const publication = deferred<undefined>()
		const started = deferred<void>()
		task.say.mockImplementationOnce(() => {
			started.resolve()
			return publication.promise
		})
		const pending = read()
		await started.promise
		expect(task.say).toHaveBeenCalledExactlyOnceWith(
			"error",
			"Error reading file source.txt: canonical lookup failed",
		)
		task.abort = true
		publication.resolve(undefined)

		const result = await pending
		expect(result.status).toBe("cancelled")
		expect(result.error).toBeUndefined()
		expect(result.nativeContent).toBeUndefined()
		expect(task.say).toHaveBeenCalledOnce()
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("does not open a target whose resolution completes after abort at the reusable content boundary", async () => {
		const target = await ReadFileTarget.resolve(path.join(directory, "source.txt"))
		vi.clearAllMocks()
		const resolution = deferred<ReadFileTarget>()
		const started = deferred<void>()
		vi.spyOn(ReadFileTarget, "resolve").mockImplementationOnce(() => {
			started.resolve()
			return resolution.promise
		})
		// This public-boundary host double omits Task members unrelated to file reading.
		const pending = new ReadFileContentReader().read({ path: "source.txt" }, task as unknown as Task, {})
		await started.promise
		task.abort = true
		resolution.resolve(target)

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(fs.open).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("stops canonical metadata work inside the reusable content reader after abandonment", async () => {
		const canonical = deferred<string>()
		const started = deferred<void>()
		vi.mocked(fs.realpath).mockImplementationOnce(() => {
			started.resolve()
			return canonical.promise
		})
		// This public-boundary host double omits Task members unrelated to file reading.
		const pending = new ReadFileContentReader().read({ path: "source.txt" }, task as unknown as Task, {})
		await started.promise
		task.abandoned = true
		canonical.resolve(path.join(directory, "source.txt"))

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(fs.lstat).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("does no canonical I/O for a pre-aborted reusable content read", async () => {
		task.abort = true
		// This public-boundary host double omits Task members unrelated to file reading.
		const result = await new ReadFileContentReader().read({ path: "source.txt" }, task as unknown as Task, {})

		expect(result.status).toBe("cancelled")
		expect(fs.realpath).not.toHaveBeenCalled()
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("does not classify cancellation during denied-feedback publication as a user rejection", async () => {
		task.ask.mockResolvedValueOnce({ response: "noButtonClicked", text: "Do not read" })
		const publication = deferred<undefined>()
		const started = deferred<void>()
		task.say.mockImplementationOnce(() => {
			started.resolve()
			return publication.promise
		})
		const pending = read()
		await started.promise
		task.abandoned = true
		publication.resolve(undefined)

		expect(await pending).toMatchObject({ status: "cancelled", feedbackText: "Do not read" })
		expect(task.didRejectTool).toBe(false)
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("retains received feedback when its pending publication rejects after abort", async () => {
		task.ask.mockResolvedValueOnce({ response: "yesButtonClicked", text: "Inspect only" })
		const publication = deferred<undefined>()
		const started = deferred<void>()
		task.say.mockImplementationOnce(() => {
			started.resolve()
			return publication.promise
		})
		const pending = read()
		await started.promise
		task.abort = true
		publication.reject(new Error("late publication failure"))

		expect(await pending).toMatchObject({ status: "cancelled", feedbackText: "Inspect only" })
		expect(task.say).toHaveBeenCalledOnce()
		expect(task.didToolFailInCurrentTurn).toBe(false)
		expect(fs.open).not.toHaveBeenCalled()
	})

	it("closes the real descriptor when pending fstat rejects after abandonment without error UI", async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const inspection = deferred<Awaited<ReturnType<fs.FileHandle["stat"]>>>()
		const started = deferred<void>()
		const opened = deferred<fs.FileHandle>()
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await actual.open(...args)
			vi.spyOn(file, "stat").mockImplementationOnce(() => {
				started.resolve()
				return inspection.promise
			})
			opened.resolve(file)
			return file
		})
		const pending = read()
		await started.promise
		task.abandoned = true
		inspection.reject(new Error("late fstat failure"))

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect((await opened.promise).fd).toBe(-1)
		expect(task.say).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("keeps uncancelled image-processing rejection visible as a technical error", async () => {
		await fs.writeFile(path.join(directory, "image.png"), Buffer.from([137, 80, 78, 71, 0]))
		const processing = deferred<Awaited<ReturnType<typeof processImageFile>>>()
		const started = deferred<void>()
		vi.mocked(processImageFile).mockImplementationOnce(() => {
			started.resolve()
			return processing.promise
		})
		const pending = read("image.png")
		await started.promise
		processing.reject(new Error("technical processing failure"))

		expect(await pending).toMatchObject({
			status: "error",
			error: "Error reading image file: technical processing failure",
		})
		expect(task.say).toHaveBeenCalledExactlyOnceWith(
			"error",
			"Error reading image file image.png: technical processing failure",
		)
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("discards content after abandonment during already-started context persistence", async () => {
		const registration = deferred<void>()
		const started = deferred<void>()
		task.fileContextTracker.trackFileContext.mockImplementationOnce(() => {
			started.resolve()
			return registration.promise
		})
		const pending = read()
		await started.promise
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledExactlyOnceWith("source.txt", "read_tool")
		task.abandoned = true
		registration.resolve()

		const result = await pending
		expect(result.status).toBe("cancelled")
		expect(result.nativeContent).toBeUndefined()
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledOnce()
		expect(task.say).not.toHaveBeenCalled()
	})

	it("does not publish tracking errors when already-started context persistence rejects after abort", async () => {
		const registration = deferred<void>()
		const started = deferred<void>()
		task.fileContextTracker.trackFileContext.mockImplementationOnce(() => {
			started.resolve()
			return registration.promise
		})
		const pending = read()
		await started.promise
		task.abort = true
		registration.reject(new Error("late tracking failure"))

		const result = await pending
		expect(result.status).toBe("cancelled")
		expect(result.nativeContent).toBeUndefined()
		expect(task.say).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it("does not calculate clipping metadata after text-only tracking settles following abort", async () => {
		const clipped = vi.spyOn(ReadFileTextProcessor.prototype, "hasClippedLines")
		const registration = deferred<void>()
		const started = deferred<void>()
		task.fileContextTracker.trackFileContext.mockImplementationOnce(() => {
			started.resolve()
			return registration.promise
		})
		const pending = read("source.txt", { textOnly: true })
		await started.promise
		task.abort = true
		registration.resolve()

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(clipped).not.toHaveBeenCalled()
	})

	it("does not decode ordinary text bytes arriving after abandonment", async () => {
		const bytes = Buffer.from("late ordinary content")
		const decode = vi.spyOn(bytes, "toString")
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const started = deferred<void>()
		const release = deferred<void>()
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await actual.open(...args)
			vi.spyOn(file, "readFile").mockImplementationOnce(async () => {
				started.resolve()
				await release.promise
				return bytes
			})
			return file
		})
		const pending = read()
		await started.promise
		task.abandoned = true
		release.resolve()

		expect(await pending).toMatchObject({ status: "cancelled" })
		expect(decode).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("retains approval feedback if a technical read diagnostic completes after cancellation", async () => {
		task.ask.mockResolvedValueOnce({ response: "yesButtonClicked", text: "Inspect only" })
		vi.spyOn(ReadFileContentReader.prototype, "read").mockRejectedValueOnce(new Error("read failure"))
		const publication = deferred<undefined>()
		const started = deferred<void>()
		task.say.mockImplementation((type) => {
			if (type === "error") {
				started.resolve()
				return publication.promise
			}
			return Promise.resolve(undefined)
		})
		const pending = read()
		await started.promise
		task.abort = true
		publication.resolve(undefined)

		expect(await pending).toMatchObject({ status: "cancelled", feedbackText: "Inspect only" })
		expect(task.say).toHaveBeenCalledTimes(2)
	})

	it("cancellation wins over a late denied approval result without dropping its feedback", async () => {
		const approval = deferred<FileResult>()
		const started = deferred<void>()
		vi.spyOn(ReadFileAccess.prototype, "requestApproval").mockImplementationOnce(() => {
			started.resolve()
			return approval.promise
		})
		const pending = read()
		await started.promise
		task.abandoned = true
		approval.resolve({
			path: "source.txt",
			status: "denied",
			feedbackText: "Do not read",
			nativeContent: "Denied by user",
		})

		const result = await pending
		expect(result).toMatchObject({ status: "cancelled", feedbackText: "Do not read" })
		expect(result.nativeContent).toBeUndefined()
		expect(fs.open).not.toHaveBeenCalled()
	})
})
