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

		expect(result.effectiveToolNames).not.toContain("execute_command")
		expect(result.effectiveToolNames).toContain("edit")
		expect(result.effectiveToolNames).not.toContain("search_and_replace")
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

		expect(result.effectiveToolNames).not.toContain("execute_command")
		expect(result.effectiveToolNames).toContain("read_file")
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
		expect(result.effectiveToolNames).not.toContain("execute_command")
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

		expect(codeResult.effectiveToolNames).toContain("ask_followup_question")
		expect(codeResult.effectiveToolNames).toContain("attempt_completion")
		expect(orchestratorResult.effectiveToolNames).toContain("new_task")
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

		expect(result.effectiveToolNames).not.toContain("access_mcp_resource")
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

		expect(result.effectiveToolNames).toContain("access_mcp_resource")
		expect(Array.from(result.effectiveToolNames).some((name) => name.startsWith("mcp--"))).toBe(false)
	})
})
