// npx vitest services/tree-sitter/__tests__/parseSourceCodeDefinitions.swift.spec.ts
//
// PERFORMANCE NOTE:
// The first query.captures() call for Swift WASM takes ~22-24 seconds due to
// WASM JIT compilation of the 3.1MB tree-sitter-swift.wasm grammar.
// Subsequent calls take ~1.4ms (already compiled).
// We warm up the query in beforeAll() and log the timing.

import { swiftQuery } from "../queries"
import { initializeTreeSitter, testParseSourceCodeDefinitions, infoLog, warmUpLanguage } from "./helpers"
import { Language, Query } from "web-tree-sitter"
import * as path from "path"
import sampleSwiftContent from "./fixtures/sample-swift"

// Swift test options
const testOptions = {
	language: "swift",
	wasmFile: "tree-sitter-swift.wasm",
	queryString: swiftQuery,
	extKey: "swift",
}

// Mock fs module
vi.mock("fs/promises")

// Mock languageParser module
vi.mock("../languageParser", () => ({
	loadRequiredLanguageParsers: vi.fn(),
}))

// Mock file existence check
vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockImplementation(() => Promise.resolve(true)),
}))

// This is insanely slow for some reason (first query.captures() call).
describe("parseSourceCodeDefinitionsForFile with Swift", () => {
	// Cache the result to avoid repeated slow parsing
	let parsedResult: string | undefined
	let warmupTime: number = 0

	// Run once before all tests to parse the Swift code
	// Timeout: 60s because first query.captures() warmup takes ~22-24s
	beforeAll(async () => {
		const { Parser, Language } = await initializeTreeSitter()

		// Pre-warm the WASM JIT with a throw-away query
		const wasmPath = path.join(process.cwd(), "dist/tree-sitter-swift.wasm")
		const swiftLang = await Language.load(wasmPath)
		infoLog(`Warming up Swift WASM query (first call is slow: ~22-24s)...`)
		warmupTime = await warmUpLanguage(swiftLang, swiftQuery)
		infoLog(`Warmup query took ${warmupTime.toFixed(0)}ms`)

		// Parse Swift code once and store the result
		const parseStart = performance.now()
		parsedResult = await testParseSourceCodeDefinitions("/test/file.swift", sampleSwiftContent, testOptions)
		const parseTime = performance.now() - parseStart
		infoLog(`Actual parse definitions took ${parseTime.toFixed(0)}ms`)
	}, 60_000)

	beforeEach(() => {
		vi.clearAllMocks()
	})

	// Single test for class declarations (standard, final, open, and inheriting classes)
	it("should capture class declarations with all modifiers", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*class StandardClassDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*final class FinalClassDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*open class OpenClassDefinition/)
		expect(parsedResult).toMatch(
			/\d+--\d+ \|\s*class InheritingClassDefinition: StandardClassDefinition, ProtocolDefinition/,
		)
	})

	// Single test for struct declarations (standard and generic structs)
	it("should capture struct declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*struct StandardStructDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*struct GenericStructDefinition<T: Comparable, U>/)
	})

	// Single test for protocol declarations (basic and with associated types)
	it("should capture protocol declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*protocol ProtocolDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*protocol AssociatedTypeProtocolDefinition/)
	})

	// Single test for extension declarations (for class, struct, and protocol)
	it("should capture extension declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*extension StandardClassDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*extension StandardStructDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*extension ProtocolDefinition/)
	})

	// Single test for method declarations (instance and type methods)
	it("should capture method declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*func instanceMethodDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*static func typeMethodDefinition/)
	})

	// Single test for property declarations (stored and computed)
	it("should capture property declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*var storedPropertyWithObserver: Int = 0/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*var computedProperty: String/)
	})

	// Single test for initializer declarations (designated and convenience)
	it("should capture initializer declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*init\(/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*convenience init\(/)
	})

	// Single test for deinitializer declarations
	it("should capture deinitializer declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*deinit/)
	})

	// Single test for subscript declarations
	it("should capture subscript declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*subscript\(/)
	})

	// Single test for type alias declarations
	it("should capture type alias declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*typealias DictionaryOfArrays</)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*class TypeAliasContainer/)
	})
})
