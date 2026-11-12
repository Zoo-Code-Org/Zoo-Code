import { createHash } from "crypto"
import { readFile } from "fs/promises"
import type { Node, QueryCapture, Tree } from "web-tree-sitter"
import { CodeParser } from "../parser"
import { codeIndexLog } from "../../code-index-log"
import { MAX_BLOCK_CHARS } from "../../constants"
import type { CodeBlock } from "../../interfaces"
import { ParserFatalError } from "../../parser-errors"
import { scannerExtensions } from "../../shared/supported-extensions"
import { type LanguageParser, loadRequiredLanguageParsers } from "../../../tree-sitter/languageParser"
import { parseMarkdown } from "../../../tree-sitter/markdownParser"

vi.mock("fs/promises", () => ({ readFile: vi.fn() }))
vi.mock("../../../tree-sitter/languageParser", () => ({ loadRequiredLanguageParsers: vi.fn() }))
vi.mock("../../../tree-sitter/markdownParser", () => ({ parseMarkdown: vi.fn() }))
vi.mock("../../code-index-log", () => ({ codeIndexLog: { error: vi.fn(), warn: vi.fn() } }))

type ParseDelegate = NonNullable<ConstructorParameters<typeof CodeParser>[0]>

function createNode(content: string, row = 0, children: Node[] = []): Node {
	// The parser only reads text, positions, type, children and the name field from these nodes.
	return {
		text: content,
		startPosition: { row, column: 0 },
		endPosition: { row: row + content.split("\n").length - 1, column: 0 },
		type: "function_declaration",
		children,
		childForFieldName: () => null,
	} as unknown as Node
}

function createLanguage() {
	const release = vi.fn<() => void>()
	const rootNode = createNode("source")
	// Only rootNode and delete are consumed by CodeParser.
	const tree = { rootNode, delete: release } as unknown as Tree
	const parse = vi.fn<LanguageParser[string]["parser"]["parse"]>().mockReturnValue(tree)
	const captures = vi.fn<LanguageParser[string]["query"]["captures"]>().mockReturnValue([])
	// These structural doubles supply the only parser/query methods CodeParser invokes.
	const language = { js: { parser: { parse }, query: { captures } } } as unknown as LanguageParser
	return { language, parse, captures, release }
}

function expectUnicodePreserved(blocks: CodeBlock[], content: string): void {
	expect(blocks.length).toBeGreaterThan(1)
	expect(blocks.map((block) => block.content).join("")).toBe(content)
	for (const block of blocks) {
		expect(Buffer.from(block.content, "utf8").toString("utf8")).toBe(block.content)
		expect(block.content.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS)
	}
	expect(new Set(blocks.map((block) => block.segmentHash)).size).toBe(blocks.length)
}

beforeEach(() => {
	vi.resetAllMocks()
	vi.mocked(parseMarkdown).mockReturnValue([])
})

describe("CodeParser worker contract", () => {
	it("keeps worker-safe extension support identical to the scanner", async () => {
		const delegate = vi.fn<ParseDelegate>().mockResolvedValue([])
		const parser = new CodeParser(delegate)
		const supported = scannerExtensions.filter((extension) => parser["isSupportedLanguage"](extension))
		expect(supported).toEqual(scannerExtensions)
		expect(parser["isSupportedLanguage"](".unsupported")).toBe(false)
		await expect(parser.parseFile("file.unsupported")).resolves.toEqual([])
		expect(delegate).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
	})

	it.each(["file.js", "file.TS", "file.dart", "file.rdl", "file.tla"])(
		"delegates structural parsing for %s with content, hash and signal",
		async (filePath) => {
			const blocks: CodeBlock[] = []
			const delegate = vi.fn<ParseDelegate>().mockResolvedValue(blocks)
			const signal = new AbortController().signal
			const result = await new CodeParser(delegate).parseFile(filePath, {
				content: "source",
				fileHash: "hash",
				signal,
			})
			expect(result).toBe(blocks)
			expect(delegate).toHaveBeenCalledExactlyOnceWith(filePath, "source", "hash", signal)
			expect(loadRequiredLanguageParsers).not.toHaveBeenCalled()
			expect(readFile).not.toHaveBeenCalled()
		},
	)

	it.each(["file.md", "file.markdown", "file.txt", "file.TXT", "file.vb", "file.scala", "file.swift"])(
		"keeps %s on the local Markdown/fallback path",
		async (filePath) => {
			const delegate = vi.fn<ParseDelegate>()
			const content = "Local parsing preserves Zoo language support and searchable file content."
			const blocks = await new CodeParser(delegate).parseFile(filePath, { content, fileHash: "hash" })
			expect(blocks).toHaveLength(1)
			expect(blocks[0]).toMatchObject({ content, fileHash: "hash", start_line: 1, end_line: 1 })
			expect(delegate).not.toHaveBeenCalled()
			expect(loadRequiredLanguageParsers).not.toHaveBeenCalled()
		},
	)

	it.each(["", "const value = 42"])("hashes supplied content without reading a file: %j", async (content) => {
		const delegate = vi.fn<ParseDelegate>().mockResolvedValue([])
		await new CodeParser(delegate).parseFile("file.js", { content })
		expect(delegate).toHaveBeenCalledWith(
			"file.js",
			content,
			createHash("sha256").update(content).digest("hex"),
			undefined,
		)
		expect(readFile).not.toHaveBeenCalled()
	})

	it("reads and hashes content before delegation", async () => {
		vi.mocked(readFile).mockResolvedValue("file contents")
		const delegate = vi.fn<ParseDelegate>().mockResolvedValue([])
		await new CodeParser(delegate).parseFile("file.js")
		expect(readFile).toHaveBeenCalledWith("file.js", "utf8")
		expect(delegate).toHaveBeenCalledWith(
			"file.js",
			"file contents",
			createHash("sha256").update("file contents").digest("hex"),
			undefined,
		)
	})

	it("logs ordinary read failure without delegating", async () => {
		const error = new Error("read failure")
		vi.mocked(readFile).mockRejectedValue(error)
		const delegate = vi.fn<ParseDelegate>()
		await expect(new CodeParser(delegate).parseFile("file.js")).resolves.toEqual([])
		expect(codeIndexLog.error).toHaveBeenCalledWith("Error reading file file.js:", error)
		expect(delegate).not.toHaveBeenCalled()
	})

	it.each(["file.js", "file.md", "file.txt", "file.unsupported"])(
		"rejects pre-cancelled work before reading or parsing %s",
		async (filePath) => {
			const controller = new AbortController()
			controller.abort()
			const delegate = vi.fn<ParseDelegate>()
			await expect(
				new CodeParser(delegate).parseFile(filePath, { signal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
			})
			expect(delegate).not.toHaveBeenCalled()
			expect(readFile).not.toHaveBeenCalled()
			expect(parseMarkdown).not.toHaveBeenCalled()
		},
	)

	it.each([false, true])("cancels after an in-flight read settles (read failure: %s)", async (rejectRead) => {
		const controller = new AbortController()
		vi.mocked(readFile).mockImplementation(async () => {
			controller.abort()
			if (rejectRead) throw new Error("late read failure")
			return "source"
		})
		const delegate = vi.fn<ParseDelegate>()
		await expect(
			new CodeParser(delegate).parseFile("file.js", { signal: controller.signal }),
		).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(delegate).not.toHaveBeenCalled()
		expect(codeIndexLog.error).not.toHaveBeenCalled()
	})

	it.each([
		new ParserFatalError("parse-timeout", "file.js"),
		new ParserFatalError("parser-abort", "file.js"),
		new Error("ordinary worker failure"),
	])("propagates delegate failure unchanged: %s", async (error) => {
		const delegate = vi.fn<ParseDelegate>().mockRejectedValue(error)
		await expect(new CodeParser(delegate).parseFile("file.js", { content: "source" })).rejects.toBe(error)
	})

	it("passes the worker WASM directory and requests host fallback only when captures are absent", async () => {
		const { language, captures, release } = createLanguage()
		vi.mocked(loadRequiredLanguageParsers).mockResolvedValue(language)
		const parser = new CodeParser(undefined, "extension-dist")
		const content = "Uncaptured structural content still needs to be indexed through host fallback."
		await expect(parser.parseFile("file.js", { content })).resolves.toEqual([])
		expect(loadRequiredLanguageParsers).toHaveBeenCalledExactlyOnceWith(["file.js"], "extension-dist")
		expect(parser.fallbackNeeded).toBe(true)
		expect(release).toHaveBeenCalledOnce()
		expect(parser.fallbackContent("file.js", content, "hash")[0]).toMatchObject({ content, fileHash: "hash" })

		captures.mockReturnValue([{ node: createNode(content), name: "definition.function", patternIndex: 0 }])
		const blocks = await parser.parseFile("file.js", { content })
		expect(blocks).toHaveLength(1)
		expect(parser.fallbackNeeded).toBe(false)
		expect(release).toHaveBeenCalledTimes(2)
		expect(loadRequiredLanguageParsers).toHaveBeenCalledOnce()
	})

	it.each(["file.txt", "file.md", "file.unsupported"])("resets stale fallback state for %s", async (filePath) => {
		const { language } = createLanguage()
		vi.mocked(loadRequiredLanguageParsers).mockResolvedValue(language)
		const parser = new CodeParser(undefined, "extension-dist")
		await parser.parseFile("file.js", { content: "source" })
		expect(parser.fallbackNeeded).toBe(true)
		await parser.parseFile(filePath, { content: "Enough local content to create a full indexable fallback block." })
		expect(parser.fallbackNeeded).toBe(false)
	})

	it.each(["Aborted()", "memory access out of bounds", "ordinary load failure"])(
		"handles a fresh and shared parser-load failure: %s",
		async (message) => {
			const error = new Error(message)
			let rejectLoad!: (reason: Error) => void
			const pending = new Promise<LanguageParser>((_resolve, reject) => {
				rejectLoad = reject
			})
			vi.mocked(loadRequiredLanguageParsers).mockReturnValue(pending)
			const parser = new CodeParser()
			const first = parser.parseFile("first.js", { content: "source" }).catch((failure: unknown) => failure)
			const second = parser.parseFile("second.js", { content: "source" }).catch((failure: unknown) => failure)
			rejectLoad(error)
			const results = await Promise.all([first, second])
			if (message === "ordinary load failure") expect(results).toEqual([[], []])
			else for (const result of results) expect(result).toBe(error)
			expect(loadRequiredLanguageParsers).toHaveBeenCalledOnce()
			expect(parser["pendingLoads"].size).toBe(0)
		},
	)

	it("shares a successful parser load between concurrent files", async () => {
		const { language, parse, release } = createLanguage()
		let resolveLoad!: (loaded: LanguageParser) => void
		vi.mocked(loadRequiredLanguageParsers).mockReturnValue(
			new Promise((resolve) => {
				resolveLoad = resolve
			}),
		)
		const parser = new CodeParser()
		const first = parser.parseFile("first.js", { content: "source" })
		const second = parser.parseFile("second.js", { content: "source" })
		resolveLoad(language)
		await Promise.all([first, second])
		expect(loadRequiredLanguageParsers).toHaveBeenCalledOnce()
		expect(parse).toHaveBeenCalledTimes(2)
		expect(release).toHaveBeenCalledTimes(2)
	})

	it.each(["success", "query failure", "fallback", "null tree"])("releases tree on %s", async (outcome) => {
		const { language, parse, captures, release } = createLanguage()
		vi.mocked(loadRequiredLanguageParsers).mockResolvedValue(language)
		const content = "A structural function with sufficient content for indexing and lifecycle checks."
		const error = new Error("memory access out of bounds")
		if (outcome === "query failure")
			captures.mockImplementation(() => {
				throw error
			})
		if (outcome === "success")
			captures.mockReturnValue([{ node: createNode(content), name: "definition", patternIndex: 0 }])
		if (outcome === "null tree") parse.mockReturnValue(null)
		const result = new CodeParser().parseFile("file.js", { content })
		if (outcome === "query failure") await expect(result).rejects.toBe(error)
		else expect((await result)[0].content).toBe(content)
		expect(release).toHaveBeenCalledTimes(outcome === "null tree" ? 0 : 1)
	})

	it("walks oversized children in capture order and deduplicates captured nodes", async () => {
		const { language, captures, release } = createLanguage()
		const child = createNode("A child declaration with enough meaningful content to create a code block.", 4)
		const leaf = createNode("z".repeat(2001), 8)
		const parent = createNode("p".repeat(4000), 0, [child, leaf])
		const capture = (node: Node): QueryCapture => ({ node, name: "definition", patternIndex: 0 })
		captures.mockReturnValue([capture(parent), capture(child)])
		vi.mocked(loadRequiredLanguageParsers).mockResolvedValue(language)
		const blocks = await new CodeParser().parseFile("file.js", { content: "source" })
		expect(blocks.map((block) => block.content)).toEqual([child.text, "z".repeat(1000), "z".repeat(1000), "z"])
		expect(blocks.map((block) => block.start_line)).toEqual([5, 9, 9, 9])
		expect(release).toHaveBeenCalledOnce()
	})
})

describe("CodeParser Unicode segmentation", () => {
	it.each(["lines", "supplementary long line"])("keeps fallback scaling proportional for %s", (shape) => {
		const parser = new CodeParser()
		const source =
			shape === "lines"
				? "const example = value => value.toUpperCase();\n".repeat(750)
				: ("a".repeat(999) + "\u{1f600}").repeat(32)
		const inputs = [1, 2, 4, 8].map((scale) => source.repeat(scale))
		const measure = (content: string) => {
			const samples: number[] = []
			for (let sample = 0; sample < 5; sample++) {
				const started = performance.now()
				for (let repeat = 0; repeat < 40; repeat++) parser.fallbackContent("file.txt", content, "hash")
				samples.push(performance.now() - started)
			}
			return Math.min(...samples)
		}
		for (let warmup = 0; warmup < 40; warmup++) parser.fallbackContent("file.txt", source, "hash")
		const timings = inputs.map(measure)
		expect(timings[2] / timings[0]).toBeLessThan(9)
		expect(timings[3] / timings[0]).toBeLessThan(18)
	})

	it.each([MAX_BLOCK_CHARS - 2, MAX_BLOCK_CHARS - 1, MAX_BLOCK_CHARS])(
		"keeps a supplementary code point whole at offset %s and hashes actual offsets",
		(pairOffset) => {
			const content = "a".repeat(pairOffset) + "\u{1f600}" + "b".repeat(MAX_BLOCK_CHARS + 17)
			const blocks = new CodeParser()["_chunkTextByLines"]([content], "file.js", "hash", "code", new Set(), 42)
			expectUnicodePreserved(blocks, content)
			expect(blocks[0].content.length).toBe(
				pairOffset === MAX_BLOCK_CHARS - 1 ? MAX_BLOCK_CHARS - 1 : MAX_BLOCK_CHARS,
			)
			let offset = 0
			for (const block of blocks) {
				expect(block).toMatchObject({ start_line: 42, end_line: 42, type: "code_segment" })
				expect(block.segmentHash).toBe(
					createHash("sha256")
						.update(`file.js-42-42-${offset}-${block.content.length}-${block.content.slice(0, 100)}`)
						.digest("hex"),
				)
				offset += block.content.length
			}
		},
	)

	it("uses adjusted cuts for consecutive pairs and preserves a short tail", () => {
		const content = "a".repeat(999) + ("\u{1f600}" + "a".repeat(997)).repeat(3) + "\u{1f680}"
		const blocks = new CodeParser().fallbackContent("file.txt", content, "hash")
		expectUnicodePreserved(blocks, content)
		expect(blocks.map((block) => block.content.length)).toEqual([999, 999, 999, 999, 2])
	})

	it.each(["file.md", "file.markdown", "file.txt", "file.scala", "file.vb", "file.js"])(
		"preserves Unicode through parseFile for %s",
		async (filePath) => {
			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue(createLanguage().language)
			const content = "a".repeat(999) + "\u{1f600}" + "漢é".repeat(1000)
			const blocks = await new CodeParser().parseFile(filePath, { content })
			expectUnicodePreserved(blocks, content)
		},
	)

	it.each([
		"ascii ",
		"café Ελληνικά Кириллица ",
		"漢字かなカナ한국어 ",
		"e\u0301 a\u0308 \u200d \ufe0f ",
		"\ud7ff\ue000\ufffd\uffff ",
	])("retains BMP segment contents and hashes: %j", (seed) => {
		const content = seed.repeat(500)
		const expected: CodeBlock[] = []
		for (let offset = 0; offset < content.length; offset += MAX_BLOCK_CHARS) {
			const segment = content.substring(offset, offset + MAX_BLOCK_CHARS)
			expected.push({
				file_path: "file.txt",
				identifier: null,
				type: "fallback_chunk_segment",
				start_line: 1,
				end_line: 1,
				content: segment,
				fileHash: "hash",
				segmentHash: createHash("sha256")
					.update(`file.txt-1-1-${offset}-${segment.length}-${segment.slice(0, 100)}`)
					.digest("hex"),
			})
		}
		expect(new CodeParser().fallbackContent("file.txt", content, "hash")).toEqual(expected)
	})
})
