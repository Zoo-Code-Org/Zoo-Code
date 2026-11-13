import { createHash } from "crypto"
import path from "path"
import { FileType, Uri } from "vscode"
import { v5 as uuidv5 } from "uuid"
import type { CodeBlock, ICodeParser, IEmbedder } from "../../interfaces"
import { MAX_FILE_SIZE_BYTES, QDRANT_CODE_BLOCK_NAMESPACE } from "../../constants"
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
	const normalizedFilePath = path[platform].resolve(filePath)
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
			embedder: {
				createEmbeddings: vi
					.fn<IEmbedder["createEmbeddings"]>()
					.mockResolvedValue({ embeddings: [[0.1, 0.2]] }),
			},
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
			expect(dependencies.embedder.createEmbeddings).not.toHaveBeenCalled()
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
		expect(dependencies.embedder.createEmbeddings).not.toHaveBeenCalled()
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
		expect(dependencies.embedder.createEmbeddings).not.toHaveBeenCalled()
	})

	it("skips unchanged content before parsing or embedding", async () => {
		const dependencies = setup()
		dependencies.cacheManager.getHash.mockReturnValue(hash)
		expect(await new FilePreparation(dependencies).prepareFile(filePath)).toEqual({
			path: filePath,
			status: "skipped",
			reason: "File has not changed",
		})
		expect(dependencies.cacheManager.getHash).toHaveBeenCalledWith(filePath)
		expect(dependencies.parser.parseFile).not.toHaveBeenCalled()
		expect(dependencies.embedder.createEmbeddings).not.toHaveBeenCalled()
	})

	it("returns the hash and empty points when parsing produces no blocks", async () => {
		const dependencies = setup()
		dependencies.parser.parseFile.mockResolvedValue([])
		expect(await new FilePreparation(dependencies).prepareFile(filePath)).toEqual({
			path: filePath,
			status: "processed_for_batching",
			newHash: hash,
			pointsToUpsert: [],
		})
		expect(dependencies.embedder.createEmbeddings).not.toHaveBeenCalled()
	})

	it("still parses and returns the hash without an embedder or gitignore", async () => {
		const dependencies = setup()
		expect(
			await new FilePreparation({ ...dependencies, embedder: undefined, ignoreInstance: undefined }).prepareFile(
				filePath,
			),
		).toEqual({
			path: filePath,
			status: "processed_for_batching",
			newHash: hash,
			pointsToUpsert: [],
		})
		expect(dependencies.parser.parseFile).toHaveBeenCalledWith(filePath, { content, fileHash: hash })
	})

	it("preserves normalized paths, stable IDs and embedding order at the size limit", async () => {
		const dependencies = setup()
		dependencies.fileSystem.stat.mockResolvedValue({
			type: FileType.File,
			ctime: 0,
			mtime: 0,
			size: MAX_FILE_SIZE_BYTES,
		})
		dependencies.parser.parseFile.mockResolvedValue([
			{ ...block, file_path: "src/../src/file.ts" },
			{ ...block, start_line: 8, end_line: 10, content: "second" },
		])
		dependencies.embedder.createEmbeddings.mockResolvedValue({
			embeddings: [
				[0.1, 0.2],
				[0.3, 0.4],
			],
		})
		expect(await new FilePreparation(dependencies).prepareFile(filePath)).toEqual({
			path: filePath,
			status: "processed_for_batching",
			newHash: hash,
			pointsToUpsert: [
				{
					id: uuidv5(`${normalizedFilePath}:2`, QDRANT_CODE_BLOCK_NAMESPACE),
					vector: [0.1, 0.2],
					payload: { filePath: relativeFilePath, codeChunk: content, startLine: 2, endLine: 5 },
				},
				{
					id: uuidv5(`${normalizedFilePath}:8`, QDRANT_CODE_BLOCK_NAMESPACE),
					vector: [0.3, 0.4],
					payload: { filePath: relativeFilePath, codeChunk: "second", startLine: 8, endLine: 10 },
				},
			],
		})
		expect(dependencies.fileSystem.stat).toHaveBeenCalledWith(Uri.file(filePath))
		expect(dependencies.fileSystem.readFile).toHaveBeenCalledWith(Uri.file(filePath))
		expect(dependencies.parser.parseFile).toHaveBeenCalledWith(filePath, { content, fileHash: hash })
		expect(dependencies.embedder.createEmbeddings).toHaveBeenCalledWith([content, "second"])
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
		expect(dependencies.embedder.createEmbeddings).toHaveBeenCalledOnce()
		expect(dependencies.embedder.createEmbeddings.mock.contexts[0]).toBe(dependencies.embedder)
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
				pointsToUpsert: [],
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
			expect(dependencies.embedder.createEmbeddings).not.toHaveBeenCalled()
		})
	})

	it.each(["access", "ignore", "stat", "read", "cache", "parse", "embed"])(
		"returns the original %s error as a local error",
		async (stage) => {
			const dependencies = setup()
			const error = new Error(`${stage} failed`)
			const fail = () => {
				throw error
			}
			if (stage === "access") dependencies.ignoreController.validateAccess.mockImplementation(fail)
			if (stage === "ignore") dependencies.ignoreInstance.ignores.mockImplementation(fail)
			if (stage === "stat") dependencies.fileSystem.stat.mockRejectedValue(error)
			if (stage === "read") dependencies.fileSystem.readFile.mockRejectedValue(error)
			if (stage === "cache") dependencies.cacheManager.getHash.mockImplementation(fail)
			if (stage === "parse") dependencies.parser.parseFile.mockRejectedValue(error)
			if (stage === "embed") dependencies.embedder.createEmbeddings.mockRejectedValue(error)
			const result = await new FilePreparation(dependencies).prepareFile(filePath)
			expect(result).toEqual({ path: filePath, status: "local_error", error })
			expect(result.error).toBe(error)
		},
	)

	it("does not wrap non-Error rejections", async () => {
		const dependencies = setup()
		dependencies.fileSystem.readFile.mockRejectedValue("read failed")
		expect(await new FilePreparation(dependencies).prepareFile(filePath)).toEqual({
			path: filePath,
			status: "local_error",
			error: "read failed",
		})
	})
})
