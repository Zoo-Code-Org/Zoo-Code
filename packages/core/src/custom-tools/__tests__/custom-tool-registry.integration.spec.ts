// pnpm --filter @roo-code/core test src/custom-tools/__tests__/custom-tool-registry.integration.spec.ts

import path from "path"
import { fileURLToPath } from "url"

import { CustomToolRegistry } from "../custom-tool-registry.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TEST_FIXTURES_DIR = path.join(__dirname, "fixtures")
const TEST_FIXTURES_OVERRIDE_DIR = path.join(__dirname, "fixtures-override")

describe.sequential("CustomToolRegistry integration", () => {
	let registry: CustomToolRegistry

	beforeEach(() => {
		registry = new CustomToolRegistry()
	})

	describe("loadFromDirectory", () => {
		it("should load tools from TypeScript files", async () => {
			const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)

			expect(result.loaded).toContain("simple")
			expect(registry.has("simple")).toBe(true)
		}, 300_000)

		it("should handle named exports", async () => {
			const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)

			expect(result.loaded).toContain("multi_toolA")
			expect(result.loaded).toContain("multi_toolB")
		}, 30_000)

		it("should report validation failures", async () => {
			const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)

			const invalidFailure = result.failed.find((failure) => failure.file === "invalid.ts")
			expect(invalidFailure).toBeDefined()
			expect(invalidFailure?.error).toContain("Invalid tool definition")
		}, 30_000)

		it("should return empty results for non-existent directory", async () => {
			const result = await registry.loadFromDirectory("/nonexistent/path")

			expect(result.loaded).toHaveLength(0)
			expect(result.failed).toHaveLength(0)
		})

		it("should skip non-tool exports silently", async () => {
			const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)

			expect(result.loaded).toContain("mixed_validTool")
			expect(result.loaded).not.toContain("mixed_someString")
			expect(result.loaded).not.toContain("mixed_someNumber")
			expect(result.loaded).not.toContain("mixed_someObject")
		}, 30_000)

		it("should support args as alias for parameters", async () => {
			const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)

			expect(result.loaded).toContain("legacy")

			const tool = registry.get("legacy")
			expect(tool?.parameters).toBeDefined()
		}, 30_000)
	})

	describe("clearCache", () => {
		it("should clear the TypeScript compilation cache", async () => {
			await registry.loadFromDirectory(TEST_FIXTURES_DIR)
			registry.clearCache()

			registry.clear()
			const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)

			expect(result.loaded).toContain("cached")
		}, 300_000)
	})

	describe("loadFromDirectories", () => {
		it("should load tools from multiple directories", async () => {
			const result = await registry.loadFromDirectories([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])

			expect(result.loaded).toContain("simple")
			expect(result.loaded).toContain("unique_override")
			expect(result.loaded).toContain("multi_toolA")
		}, 60_000)

		it("should allow later directories to override earlier ones", async () => {
			await registry.loadFromDirectories([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])

			const simpleTool = registry.get("simple")
			expect(simpleTool).toBeDefined()
			expect(simpleTool?.description).toBe("Simple tool - OVERRIDDEN")
		}, 60_000)

		it("should preserve order: first directory loaded first, second overrides", async () => {
			await registry.loadFromDirectories([TEST_FIXTURES_OVERRIDE_DIR, TEST_FIXTURES_DIR])

			const simpleTool = registry.get("simple")
			expect(simpleTool).toBeDefined()
			expect(simpleTool?.description).toBe("Simple tool")
		}, 60_000)

		it("should handle non-existent directories in the array", async () => {
			const result = await registry.loadFromDirectories([
				"/nonexistent/path",
				TEST_FIXTURES_DIR,
				"/another/nonexistent",
			])

			expect(result.loaded).toContain("simple")
			expect(result.failed).toHaveLength(1)
		}, 60_000)

		it("should handle empty array", async () => {
			const result = await registry.loadFromDirectories([])

			expect(result.loaded).toHaveLength(0)
			expect(result.failed).toHaveLength(0)
		})

		it("should combine results from all directories", async () => {
			const result = await registry.loadFromDirectories([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])

			const simpleCount = result.loaded.filter((name) => name === "simple").length
			expect(simpleCount).toBe(2)
		}, 60_000)
	})

	describe("loadFromDirectoriesIfStale", () => {
		it("should load tools from multiple directories when stale", async () => {
			const result = await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])

			expect(result.loaded).toContain("simple")
			expect(result.loaded).toContain("unique_override")
		}, 60_000)

		it("should not reload if directories are not stale", async () => {
			await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR])
			registry.clear()

			const result = await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR])

			expect(result.loaded).toEqual([])
		}, 30_000)

		it("should handle mixed stale and non-stale directories", async () => {
			await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR])

			const result = await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])

			expect(result.loaded).toContain("simple")
			expect(result.loaded).toContain("unique_override")
		}, 60_000)
	})
})
