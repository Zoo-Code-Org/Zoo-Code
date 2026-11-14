import { createHash } from "crypto"
import path from "path"
import { FileType, Uri } from "vscode"
import type { CodeBlock, ICodeParser } from "../../interfaces"
import { MAX_FILE_SIZE_BYTES } from "../../constants"
import { ParserLoadError } from "../parser"
import { FilePreparation } from "../file-preparation"
import type { FilePreparationDependencies } from "../file-preparation-dependencies"

// Keep path spies local to the modules under test, not Node or the test runner.
vi.mock("path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("path")>()
	return { ...actual, default: { ...actual } }
})

describe.each(["posix", "win32"] as const)("FilePreparation (%s paths)", (platform) => {
	beforeEach(() => {
		vi.spyOn(path, "resolve").mockImplementation(path[platform].resolve)
		vi.spyOn(path, "relative").mockImplementation(path[platform].relative)
		vi.spyOn(path, "normalize").mockImplementation(path[platform].normalize)
	})

	afterEach(() => vi.restoreAllMocks())

	const filePath = "/workspace/src/file.ts"
	const relativeFilePath = path[platform].join("src", "file.ts")
	const content = "test content"
	const hash = createHash("sha256").update(content).digest("hex")
	const block: CodeBlock = {
		file_path: filePath,
		identifier: null,
		type: "function",
		start_line: 2,
		end_line: 5,
		content,
		fileHash: hash,
		segmentHash: "segment",
	}

	function setup() {
		return {
			workspacePath: "/workspace",
			ignoreController: {
				validateAccess: vi
					.fn<FilePreparationDependencies["ignoreController"]["validateAccess"]>()
					.mockReturnValue(true),
			},
			ignoreInstance: { ignores: vi.fn<(path: string) => boolean>().mockReturnValue(false) },
			fileSystem: {
				stat: vi
					.fn<FilePreparationDependencies["fileSystem"]["stat"]>()
					.mockResolvedValue({ type: FileType.File, ctime: 0, mtime: 0, size: 100 }),
				readFile: vi
					.fn<FilePreparationDependencies["fileSystem"]["readFile"]>()
					.mockResolvedValue(Buffer.from(content)),
			},
			cacheManager: { getHash: vi.fn<FilePreparationDependencies["cacheManager"]["getHash"]>() },
			parser: { parseFile: vi.fn<ICodeParser["parseFile"]>().mockResolvedValue([{ ...block }]) },
		} satisfies FilePreparationDependencies
	}

	it.each([".git/config", ".hidden/file.ts", "node_modules/pkg/file.ts", "dist/file.js"])(
		"skips excluded directory %s before access or file reads",
		async (relativePath) => {
			const dependencies = setup()
			const path = `/workspace/${relativePath}`
			expect(await new FilePreparation(dependencies).prepareFile(path)).toEqual({
				path,
				status: "skipped",
				reason: "File is in an ignored directory",
			})
			expect(dependencies.ignoreController.validateAccess).not.toHaveBeenCalled()
			expect(dependencies.ignoreInstance.ignores).not.toHaveBeenCalled()
			expect(dependencies.fileSystem.stat).not.toHaveBeenCalled()
			expect(dependencies.fileSystem.readFile).not.toHaveBeenCalled()
			expect(dependencies.cacheManager.getHash).not.toHaveBeenCalled()
			expect(dependencies.parser.parseFile).not.toHaveBeenCalled()
		},
	)

	it.each(["access", "gitignore"])("skips %s exclusions before reading", async (source) => {
		const dependencies = setup()
		dependencies.ignoreController.validateAccess.mockReturnValue(source !== "access")
		dependencies.ignoreInstance.ignores.mockReturnValue(source === "gitignore")
		expect(await new FilePreparation(dependencies).prepareFile(filePath)).toEqual({
			path: filePath,
			status: "skipped",
			reason: "File is ignored by .rooignore or .gitignore",
		})
		expect(dependencies.ignoreController.validateAccess).toHaveBeenCalledWith(filePath)
		if (source === "access") {
			expect(dependencies.ignoreInstance.ignores).not.toHaveBeenCalled()
		} else {
			expect(dependencies.ignoreInstance.ignores).toHaveBeenCalledWith(relativeFilePath)
		}
		expect(dependencies.fileSystem.stat).not.toHaveBeenCalled()
		expect(dependencies.fileSystem.readFile).not.toHaveBeenCalled()
		expect(dependencies.cacheManager.getHash).not.toHaveBeenCalled()
		expect(dependencies.parser.parseFile).not.toHaveBeenCalled()
	})

	it("skips oversized files without reading them", async () => {
		const dependencies = setup()
		dependencies.fileSystem.stat.mockResolvedValue({
			type: FileType.File,
			ctime: 0,
			mtime: 0,
			size: MAX_FILE_SIZE_BYTES + 1,
		})
		expect(await new FilePreparation(dependencies).prepareFile(filePath)).toEqual({
			path: filePath,
			status: "skipped",
			reason: "File is too large",
		})
		expect(dependencies.fileSystem.readFile).not.toHaveBeenCalled()
		expect(dependencies.cacheManager.getHash).not.toHaveBeenCalled()
		expect(dependencies.parser.parseFile).not.toHaveBeenCalled()
	})

	it("skips unchanged content before parsing", async () => {
		const dependencies = setup()
		dependencies.cacheManager.getHash.mockReturnValue(hash)
		expect(await new FilePreparation(dependencies).prepareFile(filePath)).toEqual({
			path: filePath,
			status: "skipped",
			reason: "File has not changed",
		})
		expect(dependencies.cacheManager.getHash).toHaveBeenCalledWith(filePath)
		expect(dependencies.parser.parseFile).not.toHaveBeenCalled()
	})

	it("returns the hash and no blocks when parsing produces none", async () => {
		const dependencies = setup()
		dependencies.parser.parseFile.mockResolvedValue([])
		expect(await new FilePreparation(dependencies).prepareFile(filePath)).toEqual({
			path: filePath,
			status: "processed_for_batching",
			newHash: hash,
			blocks: [],
		})
	})

	it("still parses and returns the hash without gitignore", async () => {
		const dependencies = setup()
		expect(
			(await new FilePreparation({ ...dependencies, ignoreInstance: undefined }).prepareFile(filePath)).status,
		).toBe("processed_for_batching")
		expect(dependencies.parser.parseFile).toHaveBeenCalledWith(filePath, { content, fileHash: hash })
	})

	it("CI-FP-03: returns parsed blocks and the hash at the size limit and never embeds", async () => {
		const dependencies = setup()
		dependencies.fileSystem.stat.mockResolvedValue({
			type: FileType.File,
			ctime: 0,
			mtime: 0,
			size: MAX_FILE_SIZE_BYTES,
		})
		const blocks = [block, { ...block, start_line: 8, end_line: 10, content: "second" }]
		dependencies.parser.parseFile.mockResolvedValue(blocks)
		const result = await new FilePreparation(dependencies).prepareFile(filePath)
		expect(result).toEqual({ path: filePath, status: "processed_for_batching", newHash: hash, blocks })
		expect(Object.keys(dependencies)).not.toContain("embedder")
		expect(dependencies.fileSystem.stat).toHaveBeenCalledWith(Uri.file(filePath))
		expect(dependencies.fileSystem.readFile).toHaveBeenCalledWith(Uri.file(filePath))
	})

	it.each(["stat", "read"] as const)("CI-FP-01: missing source from %s returns missing", async (stage) => {
		for (const code of ["ENOENT", "FileNotFound"]) {
			const dependencies = setup()
			const missing = Object.assign(new Error("gone"), { code })
			if (stage === "stat") dependencies.fileSystem.stat.mockRejectedValue(missing)
			else dependencies.fileSystem.readFile.mockRejectedValue(missing)
			expect(await new FilePreparation(dependencies).prepareFile(filePath)).toEqual({
				path: filePath,
				status: "missing",
			})
			expect(dependencies.parser.parseFile).not.toHaveBeenCalled()
		}
	})

	it("calls service methods with their original receivers", async () => {
		const dependencies = setup()
		expect((await new FilePreparation(dependencies).prepareFile(filePath)).status).toBe("processed_for_batching")
		expect(dependencies.ignoreController.validateAccess).toHaveBeenCalledOnce()
		expect(dependencies.ignoreController.validateAccess.mock.contexts[0]).toBe(dependencies.ignoreController)
		expect(dependencies.ignoreInstance.ignores).toHaveBeenCalledOnce()
		expect(dependencies.ignoreInstance.ignores.mock.contexts[0]).toBe(dependencies.ignoreInstance)
		expect(dependencies.fileSystem.stat).toHaveBeenCalledOnce()
		expect(dependencies.fileSystem.stat.mock.contexts[0]).toBe(dependencies.fileSystem)
		expect(dependencies.fileSystem.readFile).toHaveBeenCalledOnce()
		expect(dependencies.fileSystem.readFile.mock.contexts[0]).toBe(dependencies.fileSystem)
		expect(dependencies.cacheManager.getHash).toHaveBeenCalledOnce()
		expect(dependencies.cacheManager.getHash.mock.contexts[0]).toBe(dependencies.cacheManager)
		expect(dependencies.parser.parseFile).toHaveBeenCalledOnce()
		expect(dependencies.parser.parseFile.mock.contexts[0]).toBe(dependencies.parser)
	})

	it("does not treat a hidden workspace ancestor as an excluded directory", async () => {
		const dependencies = setup()
		dependencies.workspacePath = "/.hidden/workspace"
		expect((await new FilePreparation(dependencies).prepareFile("/.hidden/workspace/src/file.ts")).status).toBe(
			"processed_for_batching",
		)
		expect(dependencies.ignoreInstance.ignores).toHaveBeenCalledWith(relativeFilePath)
	})

	describe.each(["Buffer", "Uint8Array"] as const)("UTF-8 decoding from %s", (representation) => {
		it.each([
			{ name: "ASCII", bytes: [65, 66], expectedContent: "AB" },
			{
				name: "Cyrillic, Spanish, CJK and emoji",
				bytes: [...Buffer.from("Привет, español 中文 😀", "utf-8")],
				expectedContent: "Привет, español 中文 😀",
			},
			{ name: "preserved BOM", bytes: [0xef, 0xbb, 0xbf, 65, 66], expectedContent: "\uFEFFAB" },
			{ name: "empty content", bytes: [], expectedContent: "" },
			{
				name: "invalid and truncated UTF-8 sequences",
				bytes: [65, 0xc3, 0x28, 0xff, 0xe2, 0x82],
				expectedContent: "A\uFFFD(\uFFFD\uFFFD",
			},
			{
				name: "sliced view with nonzero byteOffset",
				bytes: [0x58, 65, 0xc3, 0xb1, 0x59],
				expectedContent: "Añ",
				sliced: true,
			},
		])("decodes and hashes $name, then skips the cached content", async ({ bytes, expectedContent, sliced }) => {
			const dependencies = setup()
			const backing = representation === "Buffer" ? Buffer.from(bytes) : new Uint8Array(bytes)
			const fileContent = sliced ? backing.subarray(1, backing.length - 1) : backing
			if (sliced) {
				expect(fileContent.byteOffset).toBeGreaterThan(0)
				expect(fileContent.byteLength).toBeLessThan(backing.byteLength)
			}
			dependencies.fileSystem.readFile.mockResolvedValue(fileContent)
			dependencies.parser.parseFile.mockResolvedValue([])
			// Hash the literal expected text, not the input bytes or the production decoder's output.
			const expectedHash = createHash("sha256").update(expectedContent).digest("hex")
			const preparation = new FilePreparation(dependencies)

			expect(await preparation.prepareFile(filePath)).toEqual({
				path: filePath,
				status: "processed_for_batching",
				newHash: expectedHash,
				blocks: [],
			})
			expect(dependencies.parser.parseFile).toHaveBeenCalledWith(filePath, {
				content: expectedContent,
				fileHash: expectedHash,
			})

			dependencies.parser.parseFile.mockClear()
			dependencies.cacheManager.getHash.mockReturnValue(expectedHash)
			expect(await preparation.prepareFile(filePath)).toEqual({
				path: filePath,
				status: "skipped",
				reason: "File has not changed",
			})
			expect(dependencies.cacheManager.getHash).toHaveBeenCalledWith(filePath)
			expect(dependencies.parser.parseFile).not.toHaveBeenCalled()
		})
	})

	it.each([
		["access", "read"],
		["ignore", "read"],
		["stat", "read"],
		["read", "read"],
		["cache", "parse"],
		["parse", "parse"],
		["parser load", "parse"],
	] as const)("CI-FP-02: a %s error is a local error with activity %s", async (stage, activity) => {
		const dependencies = setup()
		const error =
			stage === "parser load" ? new ParserLoadError(".ts", new Error("wasm")) : new Error(`${stage} failed`)
		const fail = () => {
			throw error
		}
		if (stage === "access") dependencies.ignoreController.validateAccess.mockImplementation(fail)
		if (stage === "ignore") dependencies.ignoreInstance.ignores.mockImplementation(fail)
		if (stage === "stat") dependencies.fileSystem.stat.mockRejectedValue(Object.assign(error, { code: "EACCES" }))
		if (stage === "read") dependencies.fileSystem.readFile.mockRejectedValue(error)
		if (stage === "cache") dependencies.cacheManager.getHash.mockImplementation(fail)
		if (stage === "parse" || stage === "parser load") dependencies.parser.parseFile.mockRejectedValue(error)
		const result = await new FilePreparation(dependencies).prepareFile(filePath)
		expect(result).toEqual({ path: filePath, status: "local_error", activity, error })
		expect(result.error).toBe(error)
	})

	it("does not wrap non-Error rejections", async () => {
		const dependencies = setup()
		dependencies.fileSystem.readFile.mockRejectedValue("read failed")
		expect(await new FilePreparation(dependencies).prepareFile(filePath)).toEqual({
			path: filePath,
			status: "local_error",
			activity: "read",
			error: "read failed",
		})
	})
})
