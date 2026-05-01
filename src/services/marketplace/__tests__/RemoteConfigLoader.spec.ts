// npx vitest services/marketplace/__tests__/RemoteConfigLoader.spec.ts

import * as fs from "fs/promises"
import * as path from "path"

import { RemoteConfigLoader } from "../RemoteConfigLoader"
import type { MarketplaceItemType } from "@roo-code/types"

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
}))

const mockedReadFile = vi.mocked(fs.readFile)

describe("RemoteConfigLoader", () => {
	let loader: RemoteConfigLoader
	const extensionPath = path.join("/test", "extension")

	beforeEach(() => {
		loader = new RemoteConfigLoader(extensionPath)
		vi.clearAllMocks()
		loader.clearCache()
	})

	describe("loadAllItems", () => {
		it("should load and combine modes and MCPs from local marketplace assets", async () => {
			const mockModesYaml = `items:
	  - id: "test-mode"
	    name: "Test Mode"
	    description: "A test mode"
	    content: "customModes:\\n  - slug: test\\n    name: Test"
	  - id: "second-mode"
	    name: "Second Mode"
	    description: "Another test mode"
	    content: "customModes:\\n  - slug: second\\n    name: Second"`.replace(/^\t/gm, "")

			const mockMcpsYaml = `items:
	  - id: "test-mcp"
	    name: "Test MCP"
	    description: "A test MCP"
	    url: "https://github.com/test/test-mcp"
	    content: '{"command": "test"}'
	  - id: "second-mcp"
	    name: "Second MCP"
	    description: "Another test MCP"
	    url: "https://github.com/test/second-mcp"
	    content: '{"command": "second-test"}'`.replace(/^\t/gm, "")

			mockedReadFile.mockImplementation(async (filePath) => {
				if (String(filePath).endsWith("modes.yml")) {
					return mockModesYaml
				}
				if (String(filePath).endsWith("mcps.yml")) {
					return mockMcpsYaml
				}
				throw new Error(`Unknown file: ${String(filePath)}`)
			})

			const items = await loader.loadAllItems()

			expect(mockedReadFile).toHaveBeenCalledTimes(2)
			expect(mockedReadFile).toHaveBeenCalledWith(
				path.join(extensionPath, "assets", "marketplace", "modes.yml"),
				"utf-8",
			)
			expect(mockedReadFile).toHaveBeenCalledWith(
				path.join(extensionPath, "assets", "marketplace", "mcps.yml"),
				"utf-8",
			)

			expect(items).toHaveLength(4)
			expect(items[0]).toEqual({
				type: "mode",
				id: "test-mode",
				name: "Test Mode",
				description: "A test mode",
				content: "customModes:\n  - slug: test\n    name: Test",
			})
			expect(items[1]).toEqual({
				type: "mode",
				id: "second-mode",
				name: "Second Mode",
				description: "Another test mode",
				content: "customModes:\n  - slug: second\n    name: Second",
			})
			expect(items[2]).toEqual({
				type: "mcp",
				id: "test-mcp",
				name: "Test MCP",
				description: "A test MCP",
				url: "https://github.com/test/test-mcp",
				content: '{"command": "test"}',
			})
			expect(items[3]).toEqual({
				type: "mcp",
				id: "second-mcp",
				name: "Second MCP",
				description: "Another test MCP",
				url: "https://github.com/test/second-mcp",
				content: '{"command": "second-test"}',
			})
		})

		it("should use cache on subsequent calls", async () => {
			const mockModesYaml = `items:
  - id: "test-mode"
    name: "Test Mode"
    description: "A test mode"
    content: "test content"`

			const mockMcpsYaml = `items:
  - id: "test-mcp"
    name: "Test MCP"
    description: "A test MCP"
    url: "https://github.com/test/test-mcp"
    content: "test content"`

			mockedReadFile.mockImplementation(async (filePath) => {
				if (String(filePath).endsWith("modes.yml")) {
					return mockModesYaml
				}
				if (String(filePath).endsWith("mcps.yml")) {
					return mockMcpsYaml
				}
				throw new Error(`Unknown file: ${String(filePath)}`)
			})

			const items1 = await loader.loadAllItems()
			expect(mockedReadFile).toHaveBeenCalledTimes(2)

			const items2 = await loader.loadAllItems()
			expect(mockedReadFile).toHaveBeenCalledTimes(2)

			expect(items1).toEqual(items2)
		})

		it("should handle invalid data gracefully", async () => {
			const invalidModesYaml = `items:
  - id: "invalid-mode"
    # Missing required fields like name and description`

			const validMcpsYaml = `items:
  - id: "valid-mcp"
    name: "Valid MCP"
    description: "A valid MCP"
    url: "https://github.com/test/test-mcp"
    content: "test content"`

			mockedReadFile.mockImplementation(async (filePath) => {
				if (String(filePath).endsWith("modes.yml")) {
					return invalidModesYaml
				}
				if (String(filePath).endsWith("mcps.yml")) {
					return validMcpsYaml
				}
				throw new Error(`Unknown file: ${String(filePath)}`)
			})

			await expect(loader.loadAllItems()).rejects.toThrow()
		})
	})

	describe("getItem", () => {
		it("should find specific item by id and type", async () => {
			const mockModesYaml = `items:
  - id: "target-mode"
    name: "Target Mode"
    description: "The mode we want"
    content: "test content"`

			const mockMcpsYaml = `items:
  - id: "target-mcp"
    name: "Target MCP"
    description: "The MCP we want"
    url: "https://github.com/test/test-mcp"
    content: "test content"`

			mockedReadFile.mockImplementation(async (filePath) => {
				if (String(filePath).endsWith("modes.yml")) {
					return mockModesYaml
				}
				if (String(filePath).endsWith("mcps.yml")) {
					return mockMcpsYaml
				}
				throw new Error(`Unknown file: ${String(filePath)}`)
			})

			const modeItem = await loader.getItem("target-mode", "mode" as MarketplaceItemType)
			const mcpItem = await loader.getItem("target-mcp", "mcp" as MarketplaceItemType)
			const notFound = await loader.getItem("nonexistent", "mode" as MarketplaceItemType)

			expect(modeItem).toEqual({
				type: "mode",
				id: "target-mode",
				name: "Target Mode",
				description: "The mode we want",
				content: "test content",
			})

			expect(mcpItem).toEqual({
				type: "mcp",
				id: "target-mcp",
				name: "Target MCP",
				description: "The MCP we want",
				url: "https://github.com/test/test-mcp",
				content: "test content",
			})

			expect(notFound).toBeNull()
		})
	})

	describe("clearCache", () => {
		it("should clear cache and force fresh API calls", async () => {
			const mockModesYaml = `items:
  - id: "test-mode"
    name: "Test Mode"
    description: "A test mode"
    content: "test content"`

			const mockMcpsYaml = `items: []`

			mockedReadFile.mockImplementation(async (filePath) => {
				if (String(filePath).endsWith("modes.yml")) {
					return mockModesYaml
				}
				if (String(filePath).endsWith("mcps.yml")) {
					return mockMcpsYaml
				}
				throw new Error(`Unknown file: ${String(filePath)}`)
			})

			await loader.loadAllItems()
			expect(mockedReadFile).toHaveBeenCalledTimes(2)

			await loader.loadAllItems()
			expect(mockedReadFile).toHaveBeenCalledTimes(2)

			loader.clearCache()

			await loader.loadAllItems()
			expect(mockedReadFile).toHaveBeenCalledTimes(4)
		})
	})

	describe("cache expiration", () => {
		it("should expire cache after 5 minutes", async () => {
			const mockModesYaml = `items:
  - id: "test-mode"
    name: "Test Mode"
    description: "A test mode"
    content: "test content"`

			const mockMcpsYaml = `items: []`

			mockedReadFile.mockImplementation(async (filePath) => {
				if (String(filePath).endsWith("modes.yml")) {
					return mockModesYaml
				}
				if (String(filePath).endsWith("mcps.yml")) {
					return mockMcpsYaml
				}
				throw new Error(`Unknown file: ${String(filePath)}`)
			})

			const originalDateNow = Date.now
			let currentTime = 1000000

			Date.now = vi.fn(() => currentTime)

			await loader.loadAllItems()
			expect(mockedReadFile).toHaveBeenCalledTimes(2)

			await loader.loadAllItems()
			expect(mockedReadFile).toHaveBeenCalledTimes(2)

			currentTime += 6 * 60 * 1000

			await loader.loadAllItems()
			expect(mockedReadFile).toHaveBeenCalledTimes(4)

			Date.now = originalDateNow
		})
	})
})
