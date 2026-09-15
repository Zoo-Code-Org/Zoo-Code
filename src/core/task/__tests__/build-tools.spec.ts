// npx vitest src/core/task/__tests__/build-tools.spec.ts
//
// Gemini `includeAllToolsWithRestrictions` path: with the flag on, `tools`
// contains ALL declarations while `allowedFunctionNames` is derived from the
// resolver-filtered set, so every `disabledTools`/`excludedTools` entry —
// protocol tools included — leaves the callable allowlist while the
// declarations stay advertised.

import type OpenAI from "openai"
import type * as vscode from "vscode"

import type { McpServer, ModeConfig, ModelInfo } from "@roo-code/types"

import type { ClineProvider } from "../../webview/ClineProvider"
import type { McpHub } from "../../../services/mcp/McpHub"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

// Keeps the test independent of the bundled @roo-code/core package; the
// customTools experiment stays off in every case below.
vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		loadFromDirectoriesIfStale: vi.fn(),
		getAllSerialized: () => [],
	},
	formatNative: vi.fn(),
}))

import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

/**
 * ClineProvider is a heavy class; build-tools only reads `context` and
 * `getMcpHub()` from it, so a minimal object literal stands in. The double
 * declares exactly those members, narrowed via Pick to what the MCP helpers
 * actually call. ClineProvider itself structurally satisfies this shape, so
 * handing the double off as ClineProvider is a single legal assertion.
 */
type ProviderDouble = {
	context: Pick<vscode.ExtensionContext, "extensionPath" | "globalStoragePath" | "storagePath" | "logPath">
	getMcpHub: () => Pick<McpHub, "getServers"> | undefined
}

function makeProvider(servers: McpServer[] = []): ClineProvider {
	const provider: ProviderDouble = {
		context: { extensionPath: "/mock", globalStoragePath: "/mock", storagePath: "/mock", logPath: "/mock" },
		getMcpHub: () => ({ getServers: () => servers }),
	}
	return provider as ClineProvider
}

function toolNames(tools: OpenAI.Chat.ChatCompletionTool[]): string[] {
	return tools
		.filter((t): t is OpenAI.Chat.ChatCompletionFunctionTool => "function" in t && Boolean(t.function))
		.map((t) => t.function.name)
}

describe("buildNativeToolsArrayWithRestrictions — Gemini includeAllToolsWithRestrictions", () => {
	const provider = makeProvider()

	it("sends all declarations but restricts allowedFunctionNames (protocol tool follows the allowlist once disabled)", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			disabledTools: ["execute_command", "attempt_completion"],
			includeAllToolsWithRestrictions: true,
		})

		// All tools are still advertised (declarations), including the two
		// disabled ones.
		expect(toolNames(result.tools)).toContain("execute_command")
		expect(toolNames(result.tools)).toContain("attempt_completion")

		// The logical set (allowedFunctionNames) honors the policy for both:
		// an explicit disable of a protocol tool leaves the callable allowlist
		// just like any other tool.
		expect(result.allowedFunctionNames).not.toContain("attempt_completion")
		expect(result.allowedFunctionNames).not.toContain("execute_command")
	})

	it("flows mode filtering through the resolver into allowedFunctionNames", async () => {
		const customModes: ModeConfig[] = [
			{
				slug: "arch",
				name: "Architect-ish",
				roleDefinition: "",
				groups: ["read", ["edit", { fileRegex: "\\.md$" }]],
			},
		]

		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "arch",
			customModes,
			experiments: {},
			apiConfiguration: undefined,
			includeAllToolsWithRestrictions: true,
		})

		// The mode's groups do not include "command", so execute_command is not
		// in the logical set even though it is advertised in tools.
		expect(toolNames(result.tools)).toContain("execute_command")
		expect(result.allowedFunctionNames).not.toContain("execute_command")
		// Anchor: the mode's read group is still allowed, so the list is populated.
		expect(result.allowedFunctionNames).toContain("read_file")
	})

	it("default path (flag omitted) omits disabled tools from the sent declarations", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			disabledTools: ["execute_command"],
		})

		// Non-Gemini path: disabled tools are not sent at all.
		expect(toolNames(result.tools)).not.toContain("execute_command")
		expect(result.allowedFunctionNames).toBeUndefined()
	})

	it("excludes modelInfo.excludedTools from allowedFunctionNames", async () => {
		const modelInfo: ModelInfo = {
			contextWindow: 100_000,
			supportsPromptCache: true,
			excludedTools: ["read_file"],
		}

		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			modelInfo,
			includeAllToolsWithRestrictions: true,
		})

		expect(result.allowedFunctionNames).not.toContain("read_file")
		expect(result.allowedFunctionNames).toContain("attempt_completion")
	})

	it("omits dynamic MCP declarations when modelInfo.excludedTools excludes use_mcp_tool", async () => {
		// The builder forwards modelInfo to the MCP filter, so a model-level
		// exclusion of use_mcp_tool removes every mcp--* declaration from the
		// sent tools — exactly like the user-level disable — and from
		// allowedFunctionNames on the Gemini path.
		const mcpProvider = makeProvider([
			{
				name: "test-server",
				config: "{}",
				status: "connected",
				tools: [{ name: "test_tool", description: "a test tool", inputSchema: { type: "object" } }],
			},
		])
		const modelInfo: ModelInfo = {
			contextWindow: 100_000,
			supportsPromptCache: true,
			excludedTools: ["use_mcp_tool"],
		}

		const result = await buildNativeToolsArrayWithRestrictions({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			modelInfo,
		})

		expect(toolNames(result.tools).some((name) => name.startsWith("mcp--"))).toBe(false)

		const geminiResult = await buildNativeToolsArrayWithRestrictions({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			modelInfo,
			includeAllToolsWithRestrictions: true,
		})

		// The MCP declaration stays advertised (all tools are sent on this path)
		// but drops out of the callable allowlist.
		expect(toolNames(geminiResult.tools)).toContain("mcp--test-server--test_tool")
		expect(geminiResult.allowedFunctionNames?.some((name) => name.startsWith("mcp--"))).toBe(false)

		// Positive control with a modelInfo present: an exclusion-free model
		// info keeps the declarations, proving the removal above comes from the
		// exclusion rather than from the modelInfo being ignored.
		const controlResult = await buildNativeToolsArrayWithRestrictions({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			modelInfo: { contextWindow: 100_000, supportsPromptCache: true },
		})

		expect(toolNames(controlResult.tools)).toContain("mcp--test-server--test_tool")
	})

	it("omits dynamic MCP declarations when disabledTools disables use_mcp_tool", async () => {
		// The builder threads disabledTools/modelInfo into the MCP filter, so a
		// disabled use_mcp_tool removes every mcp--* declaration from the sent
		// tools, and from allowedFunctionNames on the Gemini path.
		const mcpProvider = makeProvider([
			{
				name: "test-server",
				config: "{}",
				status: "connected",
				tools: [{ name: "test_tool", description: "a test tool", inputSchema: { type: "object" } }],
			},
		])

		const result = await buildNativeToolsArrayWithRestrictions({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			disabledTools: ["use_mcp_tool"],
		})

		expect(toolNames(result.tools).some((name) => name.startsWith("mcp--"))).toBe(false)

		const geminiResult = await buildNativeToolsArrayWithRestrictions({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			disabledTools: ["use_mcp_tool"],
			includeAllToolsWithRestrictions: true,
		})

		// The MCP declaration stays advertised (all tools are sent on this path)
		// but drops out of the callable allowlist.
		expect(toolNames(geminiResult.tools)).toContain("mcp--test-server--test_tool")
		expect(geminiResult.allowedFunctionNames?.some((name) => name.startsWith("mcp--"))).toBe(false)
	})

	it("keeps dynamic MCP declarations when use_mcp_tool is not disabled or excluded", async () => {
		const mcpProvider = makeProvider([
			{
				name: "test-server",
				config: "{}",
				status: "connected",
				tools: [{ name: "test_tool", description: "a test tool", inputSchema: { type: "object" } }],
			},
		])

		const result = await buildNativeToolsArrayWithRestrictions({
			provider: mcpProvider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
		})

		expect(toolNames(result.tools)).toContain("mcp--test-server--test_tool")
	})
})
