// npx vitest run core/prompts/tools/__tests__/filter-tools-for-mode.spec.ts

import type OpenAI from "openai"
import type { ModeConfig } from "@roo-code/types"

import { filterMcpToolsForMode, filterNativeToolsForMode } from "../filter-tools-for-mode"

function makeTool(name: string): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: {
			name,
			description: `${name} tool`,
			parameters: { type: "object", properties: {} },
		},
	} as OpenAI.Chat.ChatCompletionTool
}

describe("filterNativeToolsForMode - disabledTools", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("execute_command"),
		makeTool("read_file"),
		makeTool("write_to_file"),
		makeTool("apply_diff"),
		makeTool("edit"),
	]

	it("removes tools listed in settings.disabledTools", () => {
		const settings = {
			disabledTools: ["execute_command"],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("execute_command")
		expect(resultNames).toContain("read_file")
		expect(resultNames).toContain("write_to_file")
		expect(resultNames).toContain("apply_diff")
	})

	it("does not remove any tools when disabledTools is empty", () => {
		const settings = {
			disabledTools: [],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("execute_command")
		expect(resultNames).toContain("read_file")
		expect(resultNames).toContain("write_to_file")
		expect(resultNames).toContain("apply_diff")
	})

	it("does not remove any tools when disabledTools is undefined", () => {
		const settings = {}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("execute_command")
		expect(resultNames).toContain("read_file")
	})

	it("combines disabledTools with other setting-based exclusions", () => {
		const settings = {
			disabledTools: ["execute_command"],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("execute_command")
		expect(resultNames).toContain("read_file")
	})

	it("disables canonical tool when disabledTools contains alias name", () => {
		const settings = {
			disabledTools: ["search_and_replace"],
			modelInfo: {
				includedTools: ["search_and_replace"],
			},
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("search_and_replace")
		expect(resultNames).not.toContain("edit")
	})
})

describe("filterNativeToolsForMode - settings round-trips", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [makeTool("read_file"), makeTool("update_todo_list")]

	function resultNames(result: OpenAI.Chat.ChatCompletionTool[]): string[] {
		return result.map((t) => ("function" in t && t.function ? t.function.name : ""))
	}

	it("works when the settings argument is omitted entirely", () => {
		// settings?.disabledTools / settings?.todoListEnabled must tolerate an
		// absent settings object rather than dereferencing it.
		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined)
		expect(resultNames(result)).toContain("read_file")
	})

	it("applies settings.todoListEnabled=false to the native tool set", () => {
		const without = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			todoListEnabled: false,
		})
		expect(resultNames(without)).not.toContain("update_todo_list")
		expect(resultNames(without)).toContain("read_file")

		const enabled = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			todoListEnabled: true,
		})
		expect(resultNames(enabled)).toContain("update_todo_list")
	})

	it("keeps todoListEnabled=undefined as enabled (default semantics)", () => {
		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {})
		expect(resultNames(result)).toContain("update_todo_list")
	})

	it("tolerates a modelInfo without an includedTools property", () => {
		// resolveModelAliasRenames guards with `modelInfo?.includedTools?.length`;
		// a present-but-incomplete modelInfo must take the early-return path rather
		// than dereferencing the missing property.
		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			modelInfo: {},
		})
		expect(resultNames(result)).toContain("read_file")
		expect(resultNames(result)).toContain("update_todo_list")
	})
})

describe("filterNativeToolsForMode - alias renaming", () => {
	function resultNames(result: OpenAI.Chat.ChatCompletionTool[]): string[] {
		return result.map((t) => ("function" in t && t.function ? t.function.name : ""))
	}

	it("renames an allowed canonical tool to its alias from includedTools", () => {
		// "search_and_replace" is an alias of the opt-in custom tool "edit"; listing
		// it in modelInfo.includedTools both enables "edit" and renames it, so the
		// advertised definition must carry the alias name, not the canonical one.
		const nativeTools = [makeTool("edit")]
		const settings = { modelInfo: { includedTools: ["search_and_replace"] } }

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		expect(resultNames(result)).toEqual(["search_and_replace"])
	})

	it("keeps non-aliased tool definitions identical (no needless copies)", () => {
		// A canonical name in includedTools is not an alias; the tool must be passed
		// through as the exact same definition object rather than renamed/copied.
		const readFileTool = makeTool("read_file")
		const settings = { modelInfo: { includedTools: ["read_file"] } }

		const result = filterNativeToolsForMode([readFileTool], "code", undefined, undefined, undefined, settings)

		expect(result).toHaveLength(1)
		expect(result[0]).toBe(readFileTool)
	})

	it("does not advertise an alias whose canonical tool is not allowed", () => {
		// "edit" needs the edit group; a read-only mode must drop it even when the
		// alias is requested through includedTools.
		const nativeTools = [makeTool("edit"), makeTool("read_file")]
		const settings = { modelInfo: { includedTools: ["search_and_replace"] } }
		const readOnlyMode: ModeConfig = {
			slug: "read-only",
			name: "Read Only",
			roleDefinition: "",
			groups: ["read"],
		}

		const result = filterNativeToolsForMode(
			nativeTools,
			"read-only",
			[readOnlyMode],
			undefined,
			undefined,
			settings,
		)

		const names = resultNames(result)
		expect(names).not.toContain("search_and_replace")
		expect(names).not.toContain("edit")
		expect(names).toContain("read_file")
	})

	it("reuses the cached renamed definition for repeated calls", () => {
		// Uses the write_file pair exclusively: the module-level rename cache is
		// shared across tests in this file, so the first call below must be the one
		// that stores the entry (dropping the cache write would return fresh objects).
		const nativeTools = [makeTool("write_to_file")]
		const settings = { modelInfo: { includedTools: ["write_file"] } }

		const first = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)
		const second = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		expect(resultNames(first)).toEqual(["write_file"])
		expect(second[0]).toBe(first[0])
	})

	it("keeps separate cache entries per canonical/alias pair", () => {
		// Two different renames must not collide in the rename cache: each advertised
		// tool carries its own alias name.
		const nativeTools = [makeTool("edit"), makeTool("write_to_file")]
		const settings = { modelInfo: { includedTools: ["search_and_replace", "write_file"] } }

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		expect(resultNames(result).sort()).toEqual(["search_and_replace", "write_file"])
	})

	it("skips non-function (custom) tool definitions without throwing", () => {
		// The filter loop only inspects definitions that carry a function schema;
		// a custom tool definition must be dropped, not dereferenced.
		const customTool: OpenAI.Chat.ChatCompletionTool = { type: "custom", custom: { name: "custom_tool" } }
		const nativeTools = [makeTool("read_file"), customTool]

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {})

		expect(resultNames(result)).toEqual(["read_file"])
	})

	it("skips a malformed function definition whose schema is missing", () => {
		// Defensive branch: a definition that declares the "function" key but carries
		// a nullish schema must be skipped by the loop guard rather than dereferenced.
		// The double assertion is required because the SDK types forbid this shape.
		const malformedTool = {
			...makeTool("broken_tool"),
			function: undefined,
		} as unknown as OpenAI.Chat.ChatCompletionTool
		const nativeTools = [makeTool("read_file"), malformedTool]

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {})

		expect(resultNames(result)).toEqual(["read_file"])
	})
})

describe("filterMcpToolsForMode", () => {
	const mcpTools = [makeTool("mcp_server_tool")]

	it("returns the MCP tools for a mode whose groups include mcp", () => {
		expect(filterMcpToolsForMode(mcpTools, "code", undefined, undefined)).toBe(mcpTools)
	})

	it("returns the MCP tools when the mode is undefined (default-mode fallback)", () => {
		// `mode ?? defaultModeSlug` must fall back to the default mode (code), which
		// allows use_mcp_tool.
		expect(filterMcpToolsForMode(mcpTools, undefined, undefined, undefined)).toBe(mcpTools)
	})

	it("returns an empty array for a mode without the mcp group", () => {
		const readOnlyMode: ModeConfig = {
			slug: "read-only",
			name: "Read Only",
			roleDefinition: "",
			groups: ["read"],
		}
		expect(filterMcpToolsForMode(mcpTools, "read-only", [readOnlyMode], undefined)).toEqual([])
	})

	it("resolves a custom mode from the customModes argument", () => {
		// The customModes array must be forwarded to the permission check: the mode
		// slug only exists in the custom list.
		const mcpCustomMode: ModeConfig = {
			slug: "custom-mcp",
			name: "Custom MCP",
			roleDefinition: "",
			groups: ["mcp"],
		}
		expect(filterMcpToolsForMode(mcpTools, "custom-mcp", [mcpCustomMode], undefined)).toBe(mcpTools)
	})

	it("accepts experiment flags without affecting the result", () => {
		expect(filterMcpToolsForMode(mcpTools, "code", undefined, { imageGeneration: true })).toBe(mcpTools)
	})
})

describe("filterNativeToolsForMode - access_mcp_resource allowlist", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [makeTool("read_file"), makeTool("access_mcp_resource")]

	// Minimal McpHub stub exposing only getServers(), which is all the resource
	// availability check uses.
	function makeMcpHub(servers: Array<{ name: string; resources?: unknown[] }>): any {
		return {
			getServers: () => servers,
		}
	}

	it("keeps access_mcp_resource when an allowed server has resources", () => {
		const mcpHub = makeMcpHub([{ name: "allowed-server", resources: [{ uri: "res://x" }] }])

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {}, mcpHub, [
			"allowed-server",
		])

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("access_mcp_resource")
	})

	it("removes access_mcp_resource when only a disallowed server has resources", () => {
		// The server with resources is NOT in the allowlist, so the restricted
		// mode must not retain access_mcp_resource.
		const mcpHub = makeMcpHub([
			{ name: "allowed-server", resources: [] },
			{ name: "blocked-server", resources: [{ uri: "res://secret" }] },
		])

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {}, mcpHub, [
			"allowed-server",
		])

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("access_mcp_resource")
		expect(resultNames).toContain("read_file")
	})

	it("considers all servers when no allowlist is provided (unrestricted mode)", () => {
		const mcpHub = makeMcpHub([{ name: "any-server", resources: [{ uri: "res://y" }] }])

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {}, mcpHub)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("access_mcp_resource")
	})

	it("removes access_mcp_resource when the allowlist is empty", () => {
		const mcpHub = makeMcpHub([{ name: "some-server", resources: [{ uri: "res://z" }] }])

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {}, mcpHub, [])

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("access_mcp_resource")
	})

	// Defense in depth: even if a caller forgets to thread `allowedMcpServers`, the
	// function must fall back to the mode config's own allowlist so a restricted mode
	// can never retain access_mcp_resource based on resources from disallowed servers.
	describe("falls back to modeConfig.allowedMcpServers when the parameter is omitted", () => {
		const restrictedMode = {
			slug: "restricted",
			name: "Restricted",
			roleDefinition: "restricted role",
			groups: ["read", "mcp"],
			allowedMcpServers: ["allowed-server"],
		} as any

		it("removes access_mcp_resource when only a disallowed server has resources (param omitted)", () => {
			const mcpHub = makeMcpHub([
				{ name: "allowed-server", resources: [] },
				{ name: "blocked-server", resources: [{ uri: "res://secret" }] },
			])

			// Note: the 8th argument (allowedMcpServers) is intentionally omitted to
			// simulate a caller that does not thread the allowlist through.
			const result = filterNativeToolsForMode(
				nativeTools,
				"restricted",
				[restrictedMode],
				undefined,
				undefined,
				{},
				mcpHub,
			)

			const resultNames = result.map((t) => (t as any).function.name)
			expect(resultNames).not.toContain("access_mcp_resource")
			expect(resultNames).toContain("read_file")
		})

		it("keeps access_mcp_resource when an allowed server has resources (param omitted)", () => {
			const mcpHub = makeMcpHub([
				{ name: "allowed-server", resources: [{ uri: "res://x" }] },
				{ name: "blocked-server", resources: [{ uri: "res://secret" }] },
			])

			const result = filterNativeToolsForMode(
				nativeTools,
				"restricted",
				[restrictedMode],
				undefined,
				undefined,
				{},
				mcpHub,
			)

			const resultNames = result.map((t) => (t as any).function.name)
			expect(resultNames).toContain("access_mcp_resource")
		})

		it("prefers the explicit parameter over the mode config allowlist when both are provided", () => {
			// The mode config allows "allowed-server", but the explicit parameter
			// allows only "blocked-server" (which has the resources), so the explicit
			// parameter must win and access_mcp_resource is retained.
			const mcpHub = makeMcpHub([
				{ name: "allowed-server", resources: [] },
				{ name: "blocked-server", resources: [{ uri: "res://secret" }] },
			])

			const result = filterNativeToolsForMode(
				nativeTools,
				"restricted",
				[restrictedMode],
				undefined,
				undefined,
				{},
				mcpHub,
				["blocked-server"],
			)

			const resultNames = result.map((t) => (t as any).function.name)
			expect(resultNames).toContain("access_mcp_resource")
		})
	})
})
