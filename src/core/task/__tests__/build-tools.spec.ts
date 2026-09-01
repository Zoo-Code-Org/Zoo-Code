import type * as vscode from "vscode"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import type { McpHub } from "../../../services/mcp/McpHub"
import type { ClineProvider } from "../../webview/ClineProvider"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({
			isFeatureEnabled: false,
			isFeatureConfigured: false,
			isInitialized: false,
		}),
	},
}))

const apiConfiguration: ProviderSettings = {
	apiProvider: providerIdentifiers.anthropic,
}

function createMcpHub(withCapabilities: boolean): McpHub {
	return {
		getServers: () =>
			withCapabilities
				? [
						{
							name: "test-server",
							resources: [{ uri: "test://resource", name: "Test Resource" }],
							tools: [
								{
									name: "test-tool",
									description: "Test tool",
									inputSchema: { type: "object", properties: {} },
									enabledForPrompt: true,
								},
							],
						},
					]
				: [],
		// The builder only reads server metadata from this test double.
	} as unknown as McpHub
}

function createProvider(mcpHub: McpHub): Pick<ClineProvider, "context" | "getMcpHub"> {
	return {
		context: {} as vscode.ExtensionContext,
		getMcpHub: () => mcpHub,
	}
}

describe("buildNativeToolsArrayWithRestrictions", () => {
	it.each([
		{ mode: "code", hasCommand: true, hasRead: true, hasEdit: true },
		{ mode: "debug", hasCommand: true, hasRead: true, hasEdit: true },
		{ mode: "architect", hasCommand: false, hasRead: true, hasEdit: true },
		{ mode: "ask", hasCommand: false, hasRead: true, hasEdit: false },
		{ mode: "orchestrator", hasCommand: false, hasRead: false, hasEdit: false },
	])("resolves the built-in $mode mode tool policy", async ({ mode, hasCommand, hasRead, hasEdit }) => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider: createProvider(createMcpHub(false)),
			cwd: "/test/path",
			mode,
			customModes: undefined,
			experiments: {},
			apiConfiguration,
		})

		expect(result.effectiveToolNames.has("execute_command")).toBe(hasCommand)
		expect(result.effectiveToolNames.has("read_file")).toBe(hasRead)
		expect(result.effectiveToolNames.has("list_files")).toBe(hasRead)
		expect(result.effectiveToolNames.has("write_to_file")).toBe(hasEdit)
	})

	it("returns canonical names for the request's logical tool set", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider: createProvider(createMcpHub(false)),
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration,
			disabledTools: ["execute_command"],
			modelInfo: {
				contextWindow: 200_000,
				supportsPromptCache: true,
				includedTools: ["search_and_replace"],
			},
		})

		expect(result.effectiveToolNames.has("execute_command")).toBe(false)
		expect(result.effectiveToolNames.has("edit")).toBe(true)
		expect(result.effectiveToolNames.has("search_and_replace")).toBe(false)
	})

	it("removes model-excluded tools from logical availability", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider: createProvider(createMcpHub(false)),
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration,
			modelInfo: {
				contextWindow: 200_000,
				supportsPromptCache: true,
				excludedTools: ["execute_command"],
			},
		})

		expect(result.effectiveToolNames.has("execute_command")).toBe(false)
		expect(result.effectiveToolNames.has("read_file")).toBe(true)
	})

	it("separates Gemini compatibility definitions from logical availability", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider: createProvider(createMcpHub(false)),
			cwd: "/test/path",
			mode: "architect",
			customModes: undefined,
			experiments: {},
			apiConfiguration,
			includeAllToolsWithRestrictions: true,
		})
		const sentToolNames = result.tools.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))

		expect(sentToolNames).toContain("execute_command")
		expect(result.effectiveToolNames.has("execute_command")).toBe(false)
		expect(result.allowedFunctionNames).not.toContain("execute_command")
	})

	it("keeps lifecycle and active-mode essential tools available", async () => {
		const provider = createProvider(createMcpHub(false))
		const codeResult = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration,
			disabledTools: ["ask_followup_question", "attempt_completion"],
		})
		const orchestratorResult = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "orchestrator",
			customModes: undefined,
			experiments: {},
			apiConfiguration,
			disabledTools: ["new_task"],
		})

		expect(codeResult.effectiveToolNames.has("ask_followup_question")).toBe(true)
		expect(codeResult.effectiveToolNames.has("attempt_completion")).toBe(true)
		expect(orchestratorResult.effectiveToolNames.has("new_task")).toBe(true)
	})

	it("excludes MCP operations when MCP is globally disabled", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider: createProvider(createMcpHub(true)),
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration,
			mcpEnabled: false,
		})

		expect(result.effectiveToolNames.has("access_mcp_resource")).toBe(false)
		expect(Array.from(result.effectiveToolNames).some((name) => name.startsWith("mcp--"))).toBe(false)
	})

	it("excludes dynamic MCP tools when use_mcp_tool is disabled", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider: createProvider(createMcpHub(true)),
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration,
			disabledTools: ["use_mcp_tool"],
			mcpEnabled: true,
		})

		expect(result.effectiveToolNames.has("access_mcp_resource")).toBe(true)
		expect(Array.from(result.effectiveToolNames).some((name) => name.startsWith("mcp--"))).toBe(false)
	})
})
