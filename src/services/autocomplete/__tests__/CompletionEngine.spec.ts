import * as vscode from "vscode"

vi.mock("vscode", async () => {
	const actual = await vi.importActual<typeof import("vscode")>("vscode")
	return {
		...actual,
		InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
		window: { ...actual.window, activeTextEditor: null },
		Range: class {
			start: { line: number; character: number }
			end: { line: number; character: number }
			constructor(
				startLine: number | { line: number; character: number },
				startChar: number | { line: number; character: number },
				endLine?: number,
				endChar?: number,
			) {
				if (typeof startLine === "number" && typeof startChar === "number") {
					this.start = { line: startLine, character: startChar }
					this.end = { line: endLine ?? startLine, character: endChar ?? startChar }
				} else {
					this.start = startLine as { line: number; character: number }
					this.end = startChar as { line: number; character: number }
				}
			}
		},
		InlineCompletionItem: class {
			insertText: string
			range: vscode.Range | undefined
			constructor(insertText: string, range?: vscode.Range) {
				this.insertText = insertText
				this.range = range
			}
		},
		CancellationTokenSource: class {
			token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }
			cancel() {
				;(this.token as { isCancellationRequested: boolean }).isCancellationRequested = true
			}
			dispose() {}
		},
	}
})

import { AUTOCOMPLETE_DEFAULTS, type ResolvedAutocompleteConfig } from "@roo-code/types"

import {
	CompletionEngine,
	findDuplicateDeclaration,
	isCoherentContinuation,
	unwrapChatCodeReply,
} from "../CompletionEngine"
import { CompletionCache } from "../cache/CompletionCache"
import { PromptBuilder } from "../prompt/PromptBuilder"
import { StreamPostProcessor } from "../stream/StreamPostProcessor"
import { DEFAULT_TRANSFORMS } from "../stream/transforms"
import type { FimCompletionHandler, FimRequest } from "../providers/FimCompletionHandler"

const resolvedConfig = (overrides: Partial<ResolvedAutocompleteConfig> = {}): ResolvedAutocompleteConfig => ({
	...AUTOCOMPLETE_DEFAULTS,
	enabled: true,
	provider: "ollama",
	modelId: "qwen2.5-coder:1.5b-base",
	baseUrl: "http://localhost:11434",
	triggerMode: "automatic",
	debounceMs: 0,
	minCharsTyped: 0,
	multilineMode: "auto",
	contextLength: 8192,
	maxPrefixTokens: 1024,
	maxSuffixTokens: 512,
	maxSnippetTokens: 512,
	maxOutputTokens: 256,
	temperature: 0.01,
	requestTimeoutMs: 5000,
	useRecentlyEdited: true,
	useOpenTabs: true,
	useImportDefinitions: true,
	useAst: true,
	fimTemplate: "auto",
	disabledLanguages: [],
	...overrides,
})

function makeDocument(content: string): vscode.TextDocument {
	const lines = content.split("\n")
	return {
		getText: (range?: vscode.Range) => {
			if (!range) return content
			const result: string[] = []
			for (let i = range.start.line; i <= range.end.line; i++) {
				if (i >= lines.length) break
				let line = lines[i] ?? ""
				if (i === range.start.line && i === range.end.line) {
					line = line.slice(range.start.character, range.end.character)
				} else if (i === range.start.line) {
					line = line.slice(range.start.character)
				} else if (i === range.end.line) {
					line = line.slice(0, range.end.character)
				}
				result.push(line)
			}
			return result.join("\n")
		},
		lineAt: (line: number | vscode.Position) => {
			const lineNum = typeof line === "number" ? line : line.line
			return {
				text: lines[lineNum] ?? "",
				range: new vscode.Range(lineNum, 0, lineNum, (lines[lineNum] ?? "").length),
				lineNumber: lineNum,
				rangeIncludingLineBreak: new vscode.Range(lineNum, 0, lineNum, (lines[lineNum] ?? "").length + 1),
				firstNonWhitespaceCharacterIndex: 0,
				isEmptyOrWhitespace: false,
			}
		},
		lineCount: lines.length,
		uri: { fsPath: "/test.ts", toString: () => "file:///test.ts" },
		version: 1,
		offsetAt: (pos: vscode.Position) => {
			let offset = 0
			for (let i = 0; i < pos.line; i++) {
				offset += (lines[i] ?? "").length + 1
			}
			return offset + pos.character
		},
	} as unknown as vscode.TextDocument
}

function makeFakeHandler(completion: string): FimCompletionHandler {
	return {
		id: "ollama",
		usesNativeFim: true,
		supportsStreaming: true,
		async *streamFim(request: FimRequest) {
			// Split the completion into chunks to simulate streaming
			yield completion
		},
		async listModels() {
			return []
		},
		async validate() {
			return { ok: true }
		},
	}
}

describe("CompletionEngine", () => {
	let engine: CompletionEngine

	function makeEngine(handler: FimCompletionHandler, configOverrides: Partial<ResolvedAutocompleteConfig> = {}) {
		const cache = new CompletionCache()
		return new CompletionEngine({
			getConfig: () => resolvedConfig(configOverrides),
			getApiKey: () => undefined,
			handler,
			cache,
			promptBuilder: new PromptBuilder(),
			postProcessor: new StreamPostProcessor(DEFAULT_TRANSFORMS),
		})
	}

	beforeEach(() => {
		vi.useRealTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("produces a completion item from a streamed completion", async () => {
		const handler = makeFakeHandler("b() { return a + b }")
		engine = makeEngine(handler, { debounceMs: 0 })

		const doc = makeDocument("function add(\n  return a + b\n)")
		const pos = new vscode.Position(0, 11) // after "function add("
		const context: vscode.InlineCompletionContext = {
			triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
			selectedCompletionInfo: undefined,
		}
		const token = new vscode.CancellationTokenSource().token

		const result = await engine.provideInlineCompletionItems(doc, pos, context, token)

		expect(result).toBeDefined()
		expect(result).toHaveLength(1)
		expect(result![0].insertText).toContain("b() { return a + b }")
	})

	it("returns undefined when no model is configured", async () => {
		const handler = makeFakeHandler("completion")
		engine = makeEngine(handler, { modelId: undefined })

		const doc = makeDocument("hello")
		const pos = new vscode.Position(0, 5)
		const context: vscode.InlineCompletionContext = {
			triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
			selectedCompletionInfo: undefined,
		}
		const token = new vscode.CancellationTokenSource().token

		const result = await engine.provideInlineCompletionItems(doc, pos, context, token)
		expect(result).toBeUndefined()
	})

	it("returns undefined for an empty completion", async () => {
		const handler = makeFakeHandler("   ")
		engine = makeEngine(handler, { debounceMs: 0 })

		const doc = makeDocument("hello")
		const pos = new vscode.Position(0, 5)
		const context: vscode.InlineCompletionContext = {
			triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
			selectedCompletionInfo: undefined,
		}
		const token = new vscode.CancellationTokenSource().token

		const result = await engine.provideInlineCompletionItems(doc, pos, context, token)
		expect(result).toBeUndefined()
	})

	it("serves a cached completion on a second identical request", async () => {
		let streamCount = 0
		const handler: FimCompletionHandler = {
			id: "ollama",
			usesNativeFim: true,
			supportsStreaming: true,
			async *streamFim() {
				streamCount++
				yield "completion"
			},
			async listModels() {
				return []
			},
			async validate() {
				return { ok: true }
			},
		}

		engine = makeEngine(handler, { debounceMs: 0 })

		const doc = makeDocument("hello world")
		const pos = new vscode.Position(0, 5)
		const context: vscode.InlineCompletionContext = {
			triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
			selectedCompletionInfo: undefined,
		}
		const token1 = new vscode.CancellationTokenSource().token
		const token2 = new vscode.CancellationTokenSource().token

		await engine.provideInlineCompletionItems(doc, pos, context, token1)
		expect(streamCount).toBe(1)

		// Second request with the same prefix/suffix → cache hit
		await engine.provideInlineCompletionItems(doc, pos, context, token2)
		expect(streamCount).toBe(1) // handler NOT called again
	})

	it("uses a mid-word range when the cursor is inside a word", async () => {
		const handler = makeFakeHandler("tion")
		engine = makeEngine(handler, { debounceMs: 0 })

		// Cursor inside "function" at position 4 (func|tion)
		const doc = makeDocument("function")
		const pos = new vscode.Position(0, 4)
		const context: vscode.InlineCompletionContext = {
			triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
			selectedCompletionInfo: undefined,
		}
		const token = new vscode.CancellationTokenSource().token

		const result = await engine.provideInlineCompletionItems(doc, pos, context, token)

		expect(result).toBeDefined()
		// insertText includes the already-typed "func" so VS Code replaces the word
		expect(result![0].insertText).toBe("function")
		// range covers the word from position 0 to 4
		expect(result![0].range?.start.character).toBe(0)
		expect(result![0].range?.end.character).toBe(4)
	})

	it("uses pure insertion when the cursor is at a word boundary", async () => {
		const handler = makeFakeHandler("(a, b)")
		engine = makeEngine(handler, { debounceMs: 0 })

		const doc = makeDocument("function add")
		const pos = new vscode.Position(0, 12) // after "function add"
		const context: vscode.InlineCompletionContext = {
			triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
			selectedCompletionInfo: undefined,
		}
		const token = new vscode.CancellationTokenSource().token

		const result = await engine.provideInlineCompletionItems(doc, pos, context, token)

		expect(result).toBeDefined()
		expect(result![0].insertText).toBe("(a, b)")
		// Pure insertion: range collapses to the cursor
		expect(result![0].range?.start.character).toBe(12)
		expect(result![0].range?.end.character).toBe(12)
	})

	it("returns undefined when cancelled during debounce", async () => {
		const handler = makeFakeHandler("should not appear")
		engine = makeEngine(handler, { debounceMs: 100 })

		const doc = makeDocument("hello")
		const pos = new vscode.Position(0, 5)
		const context: vscode.InlineCompletionContext = {
			triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
			selectedCompletionInfo: undefined,
		}
		const cts = new vscode.CancellationTokenSource()

		// Start the request; cancel before the debounce window elapses.
		vi.useFakeTimers()
		const promise = engine.provideInlineCompletionItems(doc, pos, context, cts.token)
		cts.cancel()
		await vi.advanceTimersByTimeAsync(200)

		const result = await promise
		vi.useRealTimers()
		expect(result).toBeUndefined()
	})
})
describe("unwrapChatCodeReply", () => {
	it("truncates at an echoed cursor marker", () => {
		// Observed leak: `def compute_square_of_number(<CURSOR><CURSOR><CURSOR>1616...`.
		// Everything from the marker on is the model re-emitting its own input.
		expect(unwrapChatCodeReply("n)<CURSOR><CURSOR>16161616", "def f(")).toBe("n)")
	})

	it("strips a fenced reply", () => {
		expect(unwrapChatCodeReply("```python\nreturn n * n\n```", "def f(n):\n    ")).toBe("return n * n")
	})

	it("strips a restated prefix line", () => {
		expect(unwrapChatCodeReply("def f(n): return n", "def f(")).toBe("n): return n")
	})

	it("leaves clean code untouched", () => {
		expect(unwrapChatCodeReply("n ** 2", "def square(")).toBe("n ** 2")
	})
})

describe("chat reply pipeline (regression)", () => {
	// The exact failure reported: a fenced multi-line body was truncated to
	// nothing because "```" was both a stop sequence and a reasoning-block
	// opener, so the stream ended at the fence that *opened* the code.
	const RAW =
		"```python\n    numbers = [1, 4, 9, 16, 25]\n    square_sum = sum(num**2 for num in numbers)\n    mean = square_sum / len(numbers)\n    return mean\n```"
	const PREFIX = "# prime stuff\ndef is_prime(n):\n    return True\n\ndef calculate_square_mean_of_list():\n    "

	async function* once(text: string): AsyncGenerator<string, void, undefined> {
		yield text
	}

	it("keeps a fenced chat reply intact and unwraps it", async () => {
		const processor = new StreamPostProcessor(DEFAULT_TRANSFORMS)
		let streamed = ""

		for await (const chunk of processor.process(once(RAW), {
			prefix: PREFIX,
			suffix: "",
			stopSequences: ["<|im_end|>", "<|endoftext|>"],
			maxLines: 12,
			isChatReply: true,
		})) {
			streamed += chunk
		}

		const final = unwrapChatCodeReply(streamed, PREFIX)

		expect(final).toContain("numbers = [1, 4, 9, 16, 25]")
		expect(final).toContain("return mean")
		expect(final).not.toContain("```")
		// The cursor already sits after the indentation, so the first line must not
		// carry it again.
		expect(final.startsWith("numbers")).toBe(true)
	})

	it("still stops a non-chat reply at a fence", async () => {
		const processor = new StreamPostProcessor(DEFAULT_TRANSFORMS)
		let streamed = ""

		for await (const chunk of processor.process(once("x = 1\n```\nprose"), {
			prefix: "",
			suffix: "",
			stopSequences: [],
			maxLines: 12,
		})) {
			streamed += chunk
		}

		expect(streamed).toBe("x = 1\n")
	})
})

describe("isCoherentContinuation", () => {
	it("rejects a function body offered mid-argument-list", () => {
		// The reported corruption: typing `def is_prime(n` produced
		// `def is_prime(nif n <= 1FalseTrue`.
		expect(isCoherentContinuation("if n <= 1:\n        return False", "def is_prime(n")).toBe(false)
	})

	it("rejects a statement keyword directly after an identifier", () => {
		expect(isCoherentContinuation("return total", "total = coun")).toBe(false)
	})

	it("allows a genuine continuation of an open call", () => {
		expect(isCoherentContinuation("umbers)", "count = len(n")).toBe(true)
		expect(isCoherentContinuation(") -> bool:", "def is_prime(n")).toBe(true)
	})

	it("allows block-level code on a blank or indented line", () => {
		expect(isCoherentContinuation("if not numbers:\n        return None", "def mean(x):\n    ")).toBe(true)
		expect(isCoherentContinuation("return total / count", "")).toBe(true)
	})

	it("allows a statement after a completed statement", () => {
		expect(isCoherentContinuation("return True", "        return False\n")).toBe(true)
	})

	it("ignores brackets inside string literals", () => {
		expect(isCoherentContinuation("return x", 'msg = "a (b"\n')).toBe(true)
	})
})

describe("isCoherentContinuation — mid-identifier restarts", () => {
	it("rejects a fresh assignment offered mid-identifier", () => {
		// Reported: `def calculate_mean` + `mean = sum(...)` fused into
		// `def calculate_meanmean = sum(...)`.
		expect(isCoherentContinuation("mean = sum(numbers) / len(numbers)", "def calculate_mean")).toBe(false)
	})

	it("allows an identifier-then-call continuation", () => {
		// `_of_list():` and `print(x)` are structurally identical, so a rule that
		// rejected calls would also reject valid completions of a partly-typed
		// name. Assignment is the one shape that reliably signals a restart.
		expect(isCoherentContinuation("nt(x)", "def pri")).toBe(true)
	})

	it("still allows genuine identifier continuation", () => {
		expect(isCoherentContinuation("_of_list():", "def calculate_mean")).toBe(true)
		expect(isCoherentContinuation("():", "def calculate_mean")).toBe(true)
	})

	it("allows assignments when the cursor is not mid-identifier", () => {
		expect(isCoherentContinuation("mean = sum(numbers)", "    ")).toBe(true)
	})
})

describe("findDuplicateDeclaration", () => {
	const PREFIX = "def calculate_mean(numbers):\n    return sum(numbers) / len(numbers)\n\n"

	it("rejects a re-declared function", () => {
		// Reported: duplicate `def calculate_mean(numbers):` blocks stacked up.
		expect(findDuplicateDeclaration("def calculate_mean(numbers):\n    return 0", PREFIX, "")).toBe(
			"calculate_mean",
		)
	})

	it("allows a genuinely new function", () => {
		expect(findDuplicateDeclaration("def calculate_median(numbers):\n    return 0", PREFIX, "")).toBeUndefined()
	})

	it("does not treat a call as a redeclaration", () => {
		expect(findDuplicateDeclaration("result = calculate_mean(values)", PREFIX, "")).toBeUndefined()
	})

	it("checks the suffix as well as the prefix", () => {
		expect(findDuplicateDeclaration("class Widget:\n    pass", "", "class Widget:\n    pass")).toBe("Widget")
	})
})
