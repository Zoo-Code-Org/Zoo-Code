// npx vitest services/tree-sitter/__tests__/inspectSwift.spec.ts
//
// PERFORMANCE NOTE:
// The first query.captures() call for Swift WASM takes ~22-24 seconds due to
// WASM JIT compilation of the 3.1MB tree-sitter-swift.wasm grammar.
// We pre-warm the WASM JIT in a beforeAll() hook and log timing.

import { inspectTreeStructure, testParseSourceCodeDefinitions, debugLog, infoLog, warmUpLanguage } from "./helpers"
import { Query } from "web-tree-sitter"
import { swiftQuery } from "../queries"
import * as path from "path"
import sampleSwiftContent from "./fixtures/sample-swift"

describe("inspectSwift", () => {
	const testOptions = {
		language: "swift",
		wasmFile: "tree-sitter-swift.wasm",
		queryString: swiftQuery,
		extKey: "swift",
	}

	beforeAll(async () => {
		// Pre-warm Swift WASM JIT
		const { initializeTreeSitter } = await import("./helpers")
		const { Language } = await initializeTreeSitter()
		const wasmPath = path.join(process.cwd(), "dist/tree-sitter-swift.wasm")
		const swiftLang = await Language.load(wasmPath)
		const warmupTime = await warmUpLanguage(swiftLang, swiftQuery)
		infoLog(`Warmup query took ${warmupTime.toFixed(0)}ms`)
	}, 60_000)

	it("should inspect Swift tree structure", async () => {
		// Should execute without throwing
		await expect(inspectTreeStructure(sampleSwiftContent, "swift")).resolves.not.toThrow()
	})

	it("should parse Swift definitions", async () => {
		// This test validates that testParseSourceCodeDefinitions produces output
		const result = await testParseSourceCodeDefinitions("test.swift", sampleSwiftContent, testOptions)
		expect(result).toBeDefined()

		// Check that the output format includes line numbers and content
		if (result) {
			expect(result).toMatch(/\d+--\d+ \| .+/)
			debugLog("Swift parsing test completed successfully")
		}
	}, 30_000)
})
