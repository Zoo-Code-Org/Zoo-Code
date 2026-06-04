/**
 * Content Reference Tool — Selector Engine
 *
 * Core matching engine that locates content fragments within a source string
 * using anchors (startAnchor/endAnchor), selectors, or line ranges.
 *
 * Matching cascade (resolveSelector):
 *   Stage 1: exact     → source.indexOf(quote)
 *   Stage 2: normalized → whitespace + punctuation normalization, then indexOf
 *   Stage 3: fuzzy     → LCS (Longest Common Substring) with tolerance
 *   Stage 4: word-boundary expansion → expand result to complete words
 */

import * as path from "path"
import type { ContentRef } from "../../../shared/tools"
import { info, successCrt } from "./superDebug"

// ─── Public Types ───────────────────────────────────────────────────────────

/**
 * Результат AST-расширения блока по ключевому слову focus.
 * Содержит точные границы синтаксического блока (функции, класса, метода).
 */
export interface FocusBlock {
	/** Полное содержимое найденного блока */
	content: string
	/** Номер строки начала блока (1-based) */
	startLine: number
	/** Номер строки конца блока (1-based) */
	endLine: number
	/** Смещение начала блока в исходном коде */
	startOffset: number
	/** Смещение конца блока в исходном коде */
	endOffset: number
}

/**
 * AST-driven focus expansion: given a file path and focus keyword,
 * find the entire syntactic block (function, class, method) containing that keyword.
 *
 * Uses vscode.executeDocumentSymbolProvider to get the symbol tree,
 * then finds the deepest symbol node containing the focus position.
 *
 * Falls back to null if vscode API is not available (e.g., tests, headless mode).
 *
 * @param filePath - absolute path to the file
 * @param focus - keyword to find (function name, class name, etc.)
 * @returns the block content with line info, or null if not found
 */
export async function resolveAstBlock(filePath: string, focus: string): Promise<FocusBlock | null> {
	try {
		// Dynamic import — vscode API is only available inside the extension host.
		const vs: any = await import("vscode")
		const uri = vs.Uri.file(filePath)
		const document = await vs.workspace.openTextDocument(uri)
		const text = document.getText()

		// Find focus position in document
		const idx = text.indexOf(focus)
		if (idx === -1) return null

		const position = document.positionAt(idx)

		// Use vscode.executeDocumentSymbolProvider to get the symbol tree
		const symbols: any[] | undefined = await vs.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri)

		if (!symbols || symbols.length === 0) return null

		// Find deepest symbol containing the focus position
		function findDeepestContaining(syms: any[], pos: any): any | null {
			for (const sym of syms) {
				if (sym.range && sym.range.contains(pos)) {
					// Check children first (deeper nesting)
					if (sym.children && sym.children.length > 0) {
						const child = findDeepestContaining(sym.children, pos)
						if (child) return child
					}
					return sym
				}
			}
			return null
		}

		const symbol = findDeepestContaining(symbols, position)
		if (!symbol) return null

		const startLine = symbol.range.start.line + 1 // 1-based
		const endLine = symbol.range.end.line + 1
		const content = document.getText(symbol.range)
		const startOffset = document.offsetAt(symbol.range.start)
		const endOffset = document.offsetAt(symbol.range.end)

		return { content, startLine, endLine, startOffset, endOffset }
	} catch {
		// Fallback: vscode API might not be available (tests, headless)
		return null
	}
}

export interface SelectorResult {
	sourceId: string
	content: string
	startOffset: number
	endOffset: number
	line?: number
	/** End line number (1-based), заполняется только при AST-расширении focus */
	endLine?: number
	/** Confidence level: 1.0 (exact) down to 0.5 (fuzzy/expanded) */
	confidence: number
	method: "exact" | "normalized" | "fuzzy" | "anchor" | "focus" | "ast"
}

export interface SelectorOptions {
	/**
	 * Allowed character mismatch ratio for fuzzy matching.
	 * Range: 0.05–0.15, default: 0.1 (10%).
	 */
	tolerance?: number
	/** Collapse whitespace sequences before matching (default: true) */
	normalizeWhitespace?: boolean
	/** Normalize punctuation (smart quotes→straight, dashes→hyphen) (default: true) */
	normalizePunctuation?: boolean
	/** Case-sensitive matching (default: false) */
	caseSensitive?: boolean
	/** Expand matched range to word boundaries (default: true) */
	expandToWords?: boolean
}

// ─── Default Options ────────────────────────────────────────────────────────

// ─── Focus (AST) Resolver ──────────────────────────────────────────────────

/**
 * AST-парсер focus: по имени функции/класса/метода находит полный
 * синтаксический блок в исходном коде.
 *
 * Поддерживаемые языки и паттерны:
 *
 * **TypeScript/JavaScript:**
 *   - `function name(...) { ... }`
 *   - `function* name(...) { ... }` (генераторы)
 *   - `async function name(...) { ... }`
 *   - `const name = (...) => { ... }` / `const name = (...) => expr`
 *   - `const name = function(...) { ... }`
 *   - `class name { ... }`
 *   - `methodName(...) { ... }` / `methodName(...): Type { ... }`
 *
 * **Python:**
 *   - `def name(...):` до конца блока (по отступам)
 *   - `class name:` до конца блока
 *   - `async def name(...):`
 *
 * **Go:**
 *   - `func name(...) { ... }`
 *   - `func (r *Receiver) name(...) { ... }`
 *
 * **Rust:**
 *   - `fn name(...) { ... }`
 *   - `fn name(...) -> Type { ... }`
 *
 * **Java/C#/C/C++:**
 *   - `public ReturnType name(...) { ... }`
 *   - `private static ReturnType name(...) { ... }`
 */
export function resolveFocus(source: string, focusName: string): FocusBlock | null {
	info("FOCUS_AST", `resolveFocus: focusName="${focusName}", sourceLength=${source.length}`)

	if (!source || !focusName) return null

	const lines = source.split("\n")
	const result = findFocusBlock(source, lines, focusName)

	if (result) {
		successCrt("FOCUS_AST", `resolved focus "${focusName}"`, {
			startLine: result.startLine,
			endLine: result.endLine,
			contentLength: result.content.length,
		})
		return result
	}

	info("FOCUS_AST", `focus "${focusName}" not found via AST, returning null`)
	return null
}

/**
 * Определяет отступ строки (количество пробелов/табов в начале).
 */
function getIndent(line: string): number {
	let i = 0
	while (i < line.length && (line[i] === " " || line[i] === "\t")) {
		i++
	}
	return i
}

/**
 * Экранирует спецсимволы для RegExp.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Находит парные фигурные скобки, начиная с `startIdx` (индекс открывающей `{`).
 * Учитывает вложенность. Возвращает индекс закрывающей `}`.
 */
function findMatchingBrace(source: string, startIdx: number): number {
	let depth = 1
	let i = startIdx + 1
	let inString = false
	let stringChar = ""
	let inTemplate = false

	while (i < source.length && depth > 0) {
		const ch = source[i]
		const prev = i > 0 ? source[i - 1] : ""

		// Пропускаем строки
		if (!inTemplate) {
			if ((ch === '"' || ch === "'" || ch === "`") && prev !== "\\") {
				if (!inString) {
					inString = true
					stringChar = ch
				} else if (ch === stringChar) {
					inString = false
				}
			}
		}

		if (!inString) {
			if (ch === "{") {
				depth++
			} else if (ch === "}") {
				depth--
			}
		}

		i++
	}

	return depth === 0 ? i - 1 : -1
}

/**
 * Находит конец Python-блока по отступам.
 * lineIdx — индекс строки, где начинается блок (def/class/async def).
 * blockIndent — отступ строки def/class.
 */
function findPythonBlockEnd(lines: string[], lineIdx: number): number {
	const blockIndent = getIndent(lines[lineIdx])
	let i = lineIdx + 1

	while (i < lines.length) {
		const line = lines[i]
		if (line.trim() === "") {
			i++
			continue
		}
		const indent = getIndent(line)
		if (indent <= blockIndent && line.trim() !== "") {
			break
		}
		i++
	}

	return i - 1 // последняя строка блока
}

/**
 * Основная логика поиска блока focus в исходном коде.
 */
function findFocusBlock(source: string, lines: string[], focusName: string): FocusBlock | null {
	const escaped = escapeRegex(focusName)

	// ─── 1. TypeScript/JavaScript: function name(...) { ... } ──────────────
	//    Паттерны:
	//    - (async\s+)?function\s*\*?\s+name\s*\(
	//    - const\s+name\s*=\s*(async\s+)?function\s*\(
	//    - const\s+name\s*=\s*(\([^)]*\)|name)\s*(:\s*\w+)?\s*=>\s*(\{|)
	//    - name\s*\([^)]*\)\s*(:\s*\w+)?\s*\{  (метод класса)
	const tsFnPattern = new RegExp(`(?:async\\s+)?function\\s*\\*?\\s*${escaped}\\s*\\(`)

	// ─── 2. TS/JS: const name = (...) => { ─────────────────────────────────
	const arrowFnBlockPattern = new RegExp(
		`const\\s+${escaped}\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|\\w+)\\s*(?::\\s*\\w+(?:<[^>]*>)?)?\\s*=>\\s*\\{`,
	)

	// ─── 3. TS/JS: const name = (...) => expr ──────────────────────────────
	const arrowFnExprPattern = new RegExp(
		`const\\s+${escaped}\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|\\w+)\\s*(?::\\s*\\w+(?:<[^>]*>)?)?\\s*=>\\s*(?!\\{)`,
	)

	// ─── 4. class name { ... } ─────────────────────────────────────────────
	const classPattern = new RegExp(
		`(?:export\\s+)?(?:abstract\\s+)?class\\s+${escaped}\\s*(?:<[^>]*>)?\\s*(?:extends\\s+\\w+(?:<[^>]*>)?\\s*)?(?:implements\\s+[^{]+)?\\s*\\{`,
	)

	// ─── 5. TS method: name(...) { ... } ───────────────────────────────────
	const methodPattern = new RegExp(`${escaped}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\s*\\{`)

	// ─── 6. Python: def name(...): ─────────────────────────────────────
	const pyDefPattern = new RegExp(`(?:async\\s+)?def\\s+${escaped}\\s*\\(`)

	// ─── 7. Python: class name: ───────────────────────────────────────
	const pyClassPattern = new RegExp(`class\\s+${escaped}\\s*(?:\\([^)]*\\))?\\s*:`)

	// ─── 8. Go: func name(...) { ──────────────────────────────────────
	const goFnPattern = new RegExp(`func\\s+(?:\\([^)]*\\)\\s+)?${escaped}\\s*\\(`)

	// ─── 9. Rust: fn name(...) { / fn name(...) -> Type { ──────────────
	const rustFnPattern = new RegExp(`fn\\s+${escaped}\\s*\\([^)]*\\)\\s*(?:->\\s*[^{]+)?\\s*\\{`)

	// ─── 10. Java/C#/C++: modifiers ReturnType name(...) { ────────────
	const javaPattern = new RegExp(
		`(?:public|private|protected|static|final|abstract|virtual|override|internal|sealed|readonly)\\s+(?:[\\w<>.\\[\\],\\s]+\\s+)?${escaped}\\s*\\(`,
	)

	// Собираем все совпадения с их приоритетами для выбора лучшего
	const candidates: Array<{
		lineIdx: number
		startLine: number
		endLine: number
		startOffset: number
		endOffset: number
		priority: number // чем выше, тем точнее
	}> = []

	// ─── Поиск в каждой строке ────────────────────────────────────────────
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]

		// --- a) TypeScript/JS: function name(...) { ---
		if (tsFnPattern.test(line)) {
			const braceIdx = findOpeningBraceAfterSignature(source, lines, i)
			if (braceIdx !== -1) {
				const endBrace = findMatchingBrace(source, braceIdx)
				if (endBrace !== -1) {
					const endLineIdx = source.slice(0, endBrace).split("\n").length - 1
					const startOffset = getLineStartOffset(lines, i)
					const endOffset = endBrace + 1
					candidates.push({
						lineIdx: i,
						startLine: i + 1,
						endLine: Math.min(endLineIdx + 1, lines.length),
						startOffset,
						endOffset,
						priority: 10,
					})
				}
			}
			continue
		}

		// --- b) TS/JS: const name = (...) => { ---
		if (arrowFnBlockPattern.test(line)) {
			const braceIdx = findOpeningBraceAfterArrow(lines, i)
			if (braceIdx !== -1) {
				const endBrace = findMatchingBrace(source, braceIdx)
				if (endBrace !== -1) {
					const endLineIdx = source.slice(0, endBrace).split("\n").length - 1
					const startOffset = getLineStartOffset(lines, i)
					const endOffset = endBrace + 1
					candidates.push({
						lineIdx: i,
						startLine: i + 1,
						endLine: Math.min(endLineIdx + 1, lines.length),
						startOffset,
						endOffset,
						priority: 10,
					})
				}
			}
			continue
		}

		// --- c) TS/JS: const name = (...) => expr (без скобок) ---
		if (arrowFnExprPattern.test(line)) {
			// Однострочное выражение — вся строка
			const startOffset = getLineStartOffset(lines, i)
			const endOffset = startOffset + line.length + 1 // + \n
			candidates.push({
				lineIdx: i,
				startLine: i + 1,
				endLine: i + 1,
				startOffset,
				endOffset: Math.min(endOffset, source.length),
				priority: 8,
			})
			continue
		}

		// --- d) class name { ---
		if (classPattern.test(line)) {
			const braceIdx = source.indexOf("{", getLineStartOffset(lines, i))
			if (braceIdx !== -1) {
				const endBrace = findMatchingBrace(source, braceIdx)
				if (endBrace !== -1) {
					const endLineIdx = source.slice(0, endBrace).split("\n").length - 1
					const startOffset = getLineStartOffset(lines, i)
					const endOffset = endBrace + 1
					candidates.push({
						lineIdx: i,
						startLine: i + 1,
						endLine: Math.min(endLineIdx + 1, lines.length),
						startOffset,
						endOffset,
						priority: 10,
					})
				}
			}
			continue
		}

		// --- e) TS method: name(...) { ---
		if (methodPattern.test(line)) {
			const braceIdx = findOpeningBraceAfterSignature(source, lines, i)
			if (braceIdx !== -1) {
				const endBrace = findMatchingBrace(source, braceIdx)
				if (endBrace !== -1) {
					const endLineIdx = source.slice(0, endBrace).split("\n").length - 1
					const startOffset = getLineStartOffset(lines, i)
					const endOffset = endBrace + 1
					candidates.push({
						lineIdx: i,
						startLine: i + 1,
						endLine: Math.min(endLineIdx + 1, lines.length),
						startOffset,
						endOffset,
						priority: 10,
					})
				}
			}
			continue
		}

		// --- f) Python: def name(...): ---
		if (pyDefPattern.test(line)) {
			const endLineIdx = findPythonBlockEnd(lines, i)
			const startOffset = getLineStartOffset(lines, i)
			const endOffset = getLineEndOffset(lines, endLineIdx)
			candidates.push({
				lineIdx: i,
				startLine: i + 1,
				endLine: endLineIdx + 1,
				startOffset,
				endOffset,
				priority: 10,
			})
			continue
		}

		// --- g) Python: class name: ---
		if (pyClassPattern.test(line)) {
			const endLineIdx = findPythonBlockEnd(lines, i)
			const startOffset = getLineStartOffset(lines, i)
			const endOffset = getLineEndOffset(lines, endLineIdx)
			candidates.push({
				lineIdx: i,
				startLine: i + 1,
				endLine: endLineIdx + 1,
				startOffset,
				endOffset,
				priority: 10,
			})
			continue
		}

		// --- h) Go: func name(...) { ---
		if (goFnPattern.test(line)) {
			const braceIdx = findOpeningBraceAfterSignature(source, lines, i)
			if (braceIdx !== -1) {
				const endBrace = findMatchingBrace(source, braceIdx)
				if (endBrace !== -1) {
					const endLineIdx = source.slice(0, endBrace).split("\n").length - 1
					const startOffset = getLineStartOffset(lines, i)
					const endOffset = endBrace + 1
					candidates.push({
						lineIdx: i,
						startLine: i + 1,
						endLine: Math.min(endLineIdx + 1, lines.length),
						startOffset,
						endOffset,
						priority: 10,
					})
				}
			}
			continue
		}

		// --- i) Rust: fn name(...) { / fn name(...) -> Type { ---
		if (rustFnPattern.test(line)) {
			const braceIdx = source.indexOf("{", getLineStartOffset(lines, i))
			if (braceIdx !== -1) {
				const endBrace = findMatchingBrace(source, braceIdx)
				if (endBrace !== -1) {
					const endLineIdx = source.slice(0, endBrace).split("\n").length - 1
					const startOffset = getLineStartOffset(lines, i)
					const endOffset = endBrace + 1
					candidates.push({
						lineIdx: i,
						startLine: i + 1,
						endLine: Math.min(endLineIdx + 1, lines.length),
						startOffset,
						endOffset,
						priority: 10,
					})
				}
			}
			continue
		}

		// --- j) Java/C#: modifiers ReturnType name(...) { ---
		if (javaPattern.test(line)) {
			const braceIdx = findOpeningBraceAfterSignature(source, lines, i)
			if (braceIdx !== -1) {
				const endBrace = findMatchingBrace(source, braceIdx)
				if (endBrace !== -1) {
					const endLineIdx = source.slice(0, endBrace).split("\n").length - 1
					const startOffset = getLineStartOffset(lines, i)
					const endOffset = endBrace + 1
					candidates.push({
						lineIdx: i,
						startLine: i + 1,
						endLine: Math.min(endLineIdx + 1, lines.length),
						startOffset,
						endOffset,
						priority: 10,
					})
				}
			}
			continue
		}
	}

	// Выбираем кандидата с наивысшим приоритетом
	// Если приоритеты равны — выбираем первое (самое раннее) совпадение
	if (candidates.length === 0) {
		return null
	}

	candidates.sort((a, b) => b.priority - a.priority || a.lineIdx - b.lineIdx)
	const best = candidates[0]

	return {
		content: source.slice(best.startOffset, best.endOffset),
		startLine: best.startLine,
		endLine: best.endLine,
		startOffset: best.startOffset,
		endOffset: best.endOffset,
	}
}

/**
 * Ищет открывающую `{` после сигнатуры функции (если она на нескольких строках).
 * Начинает поиск с указанной строки, затем идёт по следующим строкам.
 */
function findOpeningBraceAfterSignature(source: string, lines: string[], lineIdx: number): number {
	let globalIdx = getLineStartOffset(lines, lineIdx)
	for (let i = lineIdx; i < lines.length; i++) {
		const bracePos = lines[i].indexOf("{")
		if (bracePos !== -1) {
			return globalIdx + bracePos
		}
		globalIdx += lines[i].length + 1 // +1 for \n
	}
	return -1
}

/**
 * Ищет открывающую `{` после стрелочной функции (=>).
 */
function findOpeningBraceAfterArrow(lines: string[], lineIdx: number): number {
	const line = lines[lineIdx]
	const arrowIdx = line.indexOf("=>")
	if (arrowIdx === -1) return -1
	// Ищем `{` после `=>` на этой же строке
	const afterArrow = line.slice(arrowIdx + 2)
	const bracePos = afterArrow.indexOf("{")
	if (bracePos !== -1) {
		return getLineStartOffset(lines, lineIdx) + arrowIdx + 2 + bracePos
	}
	return -1
}

/**
 * Возвращает глобальное смещение (offset) начала строки в исходном тексте.
 */
function getLineStartOffset(lines: string[], lineIdx: number): number {
	let offset = 0
	for (let i = 0; i < lineIdx; i++) {
		offset += lines[i].length + 1 // +1 for \n
	}
	return offset
}

/**
 * Возвращает глобальное смещение (offset) конца строки (включая \n).
 */
function getLineEndOffset(lines: string[], lineIdx: number): number {
	let offset = getLineStartOffset(lines, lineIdx)
	offset += lines[lineIdx].length + 1 // +1 for \n
	return offset
}

const DEFAULT_OPTIONS: Required<SelectorOptions> = {
	tolerance: 0.1,
	normalizeWhitespace: true,
	normalizePunctuation: true,
	caseSensitive: false,
	expandToWords: true,
}

function resolveOptions(options?: SelectorOptions): Required<SelectorOptions> {
	return {
		tolerance: options?.tolerance ?? DEFAULT_OPTIONS.tolerance,
		normalizeWhitespace: options?.normalizeWhitespace ?? DEFAULT_OPTIONS.normalizeWhitespace,
		normalizePunctuation: options?.normalizePunctuation ?? DEFAULT_OPTIONS.normalizePunctuation,
		caseSensitive: options?.caseSensitive ?? DEFAULT_OPTIONS.caseSensitive,
		expandToWords: options?.expandToWords ?? DEFAULT_OPTIONS.expandToWords,
	}
}

// ─── Stage 1: Exact Match ───────────────────────────────────────────────────

/**
 * Returns the index of the first exact occurrence of `quote` in `source`,
 * or -1 if not found.
 */
function exactMatch(source: string, quote: string): number {
	return source.indexOf(quote)
}

// ─── Stage 2: Normalized Match ──────────────────────────────────────────────

/**
 * Internal result of text normalization, including a position map
 * to translate normalized positions back to original source positions.
 */
interface NormalizedResult {
	text: string
	/** Maps each character index in `text` to its index in the original string */
	map: number[]
}

/**
 * Normalize punctuation characters:
 * - Smart/curly quotes → straight quotes
 * - Em/en dashes → hyphen
 */
function normalizePunctuationChar(ch: string): string {
	if (/[\u2018\u2019\u201A\u201B]/.test(ch)) return "'"
	if (/[\u201C\u201D\u201E\u201F]/.test(ch)) return '"'
	if (/[\u2013\u2014]/.test(ch)) return "-"
	return ch
}

/**
 * Build a normalized version of the input text along with a position map.
 *
 * Normalization steps:
 * 1. Case folding (unless caseSensitive)
 * 2. Punctuation normalization (smart quotes, dashes)
 * 3. Whitespace collapsing (\s+ → " ")
 *
 * The position map allows translating match positions in normalized text
 * back to original source positions — critical since whitespace collapsing
 * changes character offsets.
 */
function normalizeText(text: string, options: Required<SelectorOptions>): NormalizedResult {
	const map: number[] = []
	let result = ""
	let prevWhitespace = false

	for (let i = 0; i < text.length; i++) {
		let ch = text[i]

		// Step 1: Case folding
		if (!options.caseSensitive) {
			ch = ch.toLowerCase()
		}

		// Step 2: Punctuation normalization
		if (options.normalizePunctuation) {
			ch = normalizePunctuationChar(ch)
		}

		// Step 3: Whitespace collapsing
		if (options.normalizeWhitespace && /\s/.test(ch)) {
			if (!prevWhitespace) {
				result += " "
				map.push(i)
				prevWhitespace = true
			}
			// Skip additional consecutive whitespace characters
		} else {
			result += ch
			map.push(i)
			prevWhitespace = false
		}
	}

	return { text: result, map }
}

/**
 * Find `quote` in `source` after normalizing both strings.
 *
 * Returns the position in the **original** `source` where the match begins,
 * or -1 if not found.
 */
function normalizedMatch(source: string, quote: string, options: Required<SelectorOptions>): number {
	const normSource = normalizeText(source, options)
	const normQuote = normalizeText(quote, options)

	const idx = normSource.text.indexOf(normQuote.text)
	if (idx === -1) {
		return -1
	}

	// Map the normalized index back to the original source position
	return normSource.map[idx]
}

// ─── Stage 3: LCS Fuzzy Match ───────────────────────────────────────────────

/**
 * Find the longest common **substring** (contiguous) between `source` and
 * `quote` using a 1D DP array for memory efficiency.
 *
 * If the longest common substring covers at least `(1 - tolerance)` of the
 * quote length, it is considered a match.
 *
 * Returns the source position where the match begins, or -1 if not found.
 */
function lcsFuzzyMatch(source: string, quote: string, tolerance: number): number {
	const n = source.length
	const m = quote.length
	const minMatchLen = Math.ceil(m * (1 - tolerance))

	// Trivial reject: not enough characters to meet tolerance
	if (minMatchLen <= 0) return 0
	if (minMatchLen > n) return -1

	// 1D DP array — only one row needed for LCS (substring)
	const dp = new Array(m + 1).fill(0)
	let maxLen = 0
	let endPos = 0 // position in source where the longest match ends

	for (let i = 1; i <= n; i++) {
		let prev = 0
		for (let j = 1; j <= m; j++) {
			const temp = dp[j]
			if (source[i - 1] === quote[j - 1]) {
				dp[j] = prev + 1
			} else {
				dp[j] = 0
			}
			if (dp[j] > maxLen) {
				maxLen = dp[j]
				endPos = i - 1 // 0-based end position in source
			}
			prev = temp
		}
	}

	if (maxLen >= minMatchLen) {
		return endPos - maxLen + 1
	}

	return -1
}

/**
 * Find the longest common substring between `source` and `quote` after normalizing both,
 * then map the match position back to the original source.
 */
function normalizedFuzzyMatch(source: string, quote: string, options: Required<SelectorOptions>): number {
	const normSource = normalizeText(source, options)
	const normQuote = normalizeText(quote, options)

	const idx = lcsFuzzyMatch(normSource.text, normQuote.text, options.tolerance)
	if (idx === -1) {
		return -1
	}

	return normSource.map[idx]
}

// ─── Stage 4: Word-Boundary Expansion ───────────────────────────────────────

/**
 * Expand the matched range [start, end) to complete word boundaries.
 *
 * If the first character of the match is mid-word (the preceding character
 * is also a word character), expand left to the start of that word.
 * Similarly, if the last character is mid-word, expand right to the word end.
 */
function expandToWordBoundaries(source: string, start: number, end: number): { start: number; end: number } {
	// Expand left if currently mid-word
	if (start > 0 && start < source.length && /\w/.test(source[start - 1]) && /\w/.test(source[start])) {
		while (start > 0 && /\w/.test(source[start - 1])) {
			start--
		}
	}

	// Expand right if currently mid-word
	if (end > 0 && end < source.length && /\w/.test(source[end - 1]) && /\w/.test(source[end])) {
		while (end < source.length && /\w/.test(source[end])) {
			end++
		}
	}

	return { start, end }
}

// ─── Helper: Line Number Calculation ────────────────────────────────────────

/**
 * Count newlines before `offset` to determine the 1-based line number.
 */
function calculateLine(source: string, offset: number): number {
	let line = 1
	const end = Math.min(offset, source.length)
	for (let i = 0; i < end; i++) {
		if (source[i] === "\n") {
			line++
		}
	}
	return line
}

// ─── Helper: Line Range Resolution ──────────────────────────────────────────

/**
 * Extract content by line numbers (1-based).
 * If `endLine` is omitted, extracts only `startLine`.
 */
function resolveLineRange(sourceId: string, source: string, startLine: number, endLine?: number): SelectorResult {
	const lines = source.split("\n")
	const startIdx = Math.max(0, startLine - 1)
	const endIdx = endLine != null ? Math.min(lines.length, endLine) : startIdx + 1

	if (startIdx >= lines.length) {
		throw new Error(`startLine ${startLine} exceeds source line count ${lines.length} in ${sourceId}`)
	}

	const content = lines.slice(startIdx, endIdx).join("\n")

	// Calculate startOffset by summing lengths of lines before startIdx
	let startOffset = 0
	for (let i = 0; i < startIdx; i++) {
		startOffset += lines[i].length + 1 // +1 for the newline character
	}

	const endOffset = startOffset + content.length

	return {
		sourceId,
		content,
		startOffset,
		endOffset,
		line: startLine,
		confidence: 1.0,
		method: "exact",
	}
}

// ─── Public: resolveSelector ────────────────────────────────────────────────

/**
 * Resolve a quote (selector) against a source string using the 4-stage
 * matching cascade:
 *
 *   1. **Exact** — direct indexOf
 *   2. **Normalized** — whitespace + punctuation normalization, then indexOf
 *   3. **Fuzzy** — LCS (Longest Common Substring) with configurable tolerance
 *   4. **Word-Boundary Expansion** — expand result to word boundaries
 *
 * Throws if the quote cannot be found in the source.
 */
export function resolveSelector(
	sourceId: string,
	source: string,
	quote: string,
	options?: SelectorOptions,
): SelectorResult {
	if (!source) {
		throw new Error(`Empty source provided for sourceId: ${sourceId}`)
	}
	if (!quote) {
		throw new Error(`Empty quote provided for sourceId: ${sourceId}`)
	}

	const opts = resolveOptions(options)
	info(
		"SELECTOR",
		`resolveSelector: sourceId="${sourceId}", quoteLength=${quote.length}, tolerance=${opts.tolerance}`,
	)
	let pos = -1
	let method: SelectorResult["method"] = "exact"

	// Stage 1: Exact match
	pos = exactMatch(source, quote)

	// Stage 2: Normalized match
	if (pos === -1) {
		pos = normalizedMatch(source, quote, opts)
		if (pos !== -1) {
			method = "normalized"
		}
	}

	// Stage 3: LCS Fuzzy match
	if (pos === -1) {
		pos = normalizedFuzzyMatch(source, quote, opts)
		if (pos !== -1) {
			method = "fuzzy"
		}
	}

	if (pos === -1) {
		throw new Error(`Could not find quote in source "${sourceId}" after all matching stages`)
	}

	// Stage 4: Word-boundary expansion
	let endPos = pos + quote.length
	if (opts.expandToWords) {
		const expanded = expandToWordBoundaries(source, pos, endPos)
		pos = expanded.start
		endPos = expanded.end
	}

	const content = source.slice(pos, endPos)
	const line = calculateLine(source, pos)

	// Assign confidence based on method and whether expansion occurred
	let confidence: number
	switch (method) {
		case "exact":
			confidence = opts.expandToWords && pos !== endPos - quote.length ? 0.95 : 1.0
			break
		case "normalized":
			confidence = 0.9
			break
		case "fuzzy":
			confidence = 0.7
			break
		default:
			confidence = 0.85
	}

	const result: SelectorResult = {
		sourceId,
		content,
		startOffset: pos,
		endOffset: endPos,
		line,
		confidence,
		method,
	}
	successCrt("SELECTOR", `resolved selector for "${sourceId}" via ${method}`, {
		confidence,
		contentLength: content.length,
		line,
	})
	return result
}

// ─── Public: resolveAnchorPair ──────────────────────────────────────────────

/**
 * Resolve content using an anchor pair (startAnchor + optional endAnchor).
 *
 * - Finds `startAnchor` in the source
 * - If `endAnchor` is provided, searches for it **after** the start anchor match
 * - If `endAnchor` is omitted, expands to the end of the current line
 *
 * Returns a SelectorResult containing the matched content between anchors.
 */
export function resolveAnchorPair(
	sourceId: string,
	source: string,
	startAnchor: string,
	endAnchor?: string,
	options?: SelectorOptions,
): SelectorResult {
	const opts = resolveOptions(options)
	info(
		"SELECTOR",
		`resolveAnchorPair: sourceId="${sourceId}", startAnchorLen=${startAnchor.length}, hasEndAnchor=${!!endAnchor}`,
	)

	// Find startAnchor using full cascade
	const startResult = resolveSelector(sourceId, source, startAnchor, opts)
	const anchorEnd = startResult.startOffset + startAnchor.length

	if (endAnchor) {
		// Search for endAnchor after startAnchor's end position
		const afterSource = source.slice(anchorEnd)
		// Use a temporary sourceId for the slice context
		const endResult = resolveSelector(`${sourceId}:after-start`, afterSource, endAnchor, opts)

		const endPos = anchorEnd + endResult.endOffset
		const content = source.slice(startResult.startOffset, endPos)

		return {
			sourceId,
			content,
			startOffset: startResult.startOffset,
			endOffset: endPos,
			line: startResult.line,
			confidence: Math.min(startResult.confidence, endResult.confidence),
			method: "anchor",
		}
	}

	// No endAnchor: expand to the end of the current line
	const remainingAfter = source.slice(anchorEnd)
	const lineEndIdx = remainingAfter.indexOf("\n")
	const endPos = lineEndIdx === -1 ? source.length : anchorEnd + lineEndIdx + 1 // include newline

	const content = source.slice(startResult.startOffset, endPos)

	const anchorResult: SelectorResult = {
		sourceId,
		content,
		startOffset: startResult.startOffset,
		endOffset: endPos,
		line: startResult.line,
		confidence: startResult.confidence,
		method: "anchor",
	}
	successCrt("SELECTOR", `resolved anchor pair for "${sourceId}"`, {
		confidence: anchorResult.confidence,
		contentLength: content.length,
		line: anchorResult.line,
	})
	return anchorResult
}

// ─── Public: resolveContentRef (main entry point) ───────────────────────────

/**
 * Main entry point for content reference resolution.
 *
 * Resolves a `ContentRef` against a source string using the following
 * priority chain:
 *
 *   1. **Line numbers** — if `source === "file"` and `startLine` is set
 *   2. **AST focus expansion** — if `source === "file"`, `focus` is set, and vscode API is available
 *   3. **Anchor pair** — if `startAnchor` is set
 *   4. **Selector** — if `selector` is set
 *   5. **Focus keyword** — regex-based AST fallback, then selector fallback
 *   6. **Error** — if none of the above are specified
 *
 * @param sourceId - Human-readable identifier for the source (e.g. file path)
 * @param source   - The full source text to search within
 * @param ref      - ContentRef specifying what to find
 * @param options  - Optional matching configuration
 * @param cwd      - Working directory for resolving file paths (only used when ref.source === "file")
 * @returns SelectorResult with the extracted content fragment
 * @throws If no match strategy is specified or matching fails
 */
export async function resolveContentRef(
	sourceId: string,
	source: string,
	ref: ContentRef,
	options?: SelectorOptions,
	cwd?: string,
): Promise<SelectorResult> {
	info(
		"CONTENT_REF",
		`resolveContentRef: sourceId="${sourceId}", sourceLength=${source.length}, startAnchor=${!!ref.startAnchor}, selector=${!!ref.selector}, focus=${!!ref.focus}, startLine=${ref.startLine}`,
	)

	// Priority 1: Line numbers (file source only)
	if (ref.source === "file" && ref.startLine != null) {
		const result = resolveLineRange(sourceId, source, ref.startLine, ref.endLine)
		successCrt("CONTENT_REF", `resolved line range for "${sourceId}"`, {
			startLine: ref.startLine,
			endLine: ref.endLine,
			contentLength: result.content.length,
		})
		return result
	}

	// Priority 2: AST-driven focus expansion (vscode DocumentSymbolProvider)
	// Only for file sources where we have a file path and focus keyword.
	if (ref.source === "file" && ref.focus) {
		// Resolve the absolute file path from ref.ref + cwd
		const resolvedCwd = cwd || process.cwd()
		const filePath = path.resolve(resolvedCwd, ref.ref)

		const astResult = await resolveAstBlock(filePath, ref.focus)
		if (astResult) {
			const result: SelectorResult = {
				sourceId: `file://${filePath}:${astResult.startLine}-${astResult.endLine}`,
				content: astResult.content,
				startOffset: astResult.startOffset,
				endOffset: astResult.endOffset,
				line: astResult.startLine,
				endLine: astResult.endLine,
				confidence: 1.0,
				method: "ast",
			}
			successCrt("CONTENT_REF", `resolved focus "${ref.focus}" via vscode DocumentSymbolProvider`, {
				startLine: astResult.startLine,
				endLine: astResult.endLine,
				contentLength: result.content.length,
			})
			return result
		}

		// AST fallback: vscode API not available — continue to regex-based focus / selector
		info(
			"CONTENT_REF",
			`focus "${ref.focus}" vscode AST resolution unavailable (likely headless), falling back to regex AST`,
		)
	}

	// Priority 3: Anchor pair
	if (ref.startAnchor) {
		return resolveAnchorPair(sourceId, source, ref.startAnchor, ref.endAnchor, options)
	}

	// Priority 4: Full selector
	if (ref.selector) {
		return resolveSelector(sourceId, source, ref.selector, options)
	}

	// Priority 5: Focus keyword (regex-based AST auto-expansion с fallback на selector)
	if (ref.focus) {
		// Пробуем AST-расширение (точный структурный поиск)
		const focusResult = resolveFocus(source, ref.focus)
		if (focusResult) {
			const result: SelectorResult = {
				sourceId,
				content: focusResult.content,
				startOffset: focusResult.startOffset,
				endOffset: focusResult.endOffset,
				line: focusResult.startLine,
				endLine: focusResult.endLine,
				confidence: 1.0,
				method: "focus",
			}
			successCrt("CONTENT_REF", `resolved focus "${ref.focus}" via AST expansion`, {
				startLine: focusResult.startLine,
				endLine: focusResult.endLine,
				contentLength: result.content.length,
			})
			return result
		}

		// Fallback: если AST не смог определить границы — используем обычный selector search
		info("CONTENT_REF", `focus "${ref.focus}" AST resolution failed, falling back to selector matching`)
		return resolveSelector(sourceId, source, ref.focus, options)
	}

	// No matching strategy specified
	throw new Error(
		`ContentRef for "${sourceId}" must specify at least one of: startAnchor, selector, focus, or startLine`,
	)
}
