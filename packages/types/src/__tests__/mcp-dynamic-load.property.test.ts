import { describe, expect, it } from "vitest"
import {
	DEFAULT_MCP_DYNAMIC_LOAD_INITIAL_K,
	DEFAULT_MCP_DYNAMIC_LOAD_SEARCH_TURNS,
	DEFAULT_MCP_DYNAMIC_LOAD_THRESHOLD,
	resolveMcpDynamicLoadSettings,
} from "../mcp.js"

const invalid: unknown[] = [undefined, null, "2", {}, [], NaN, Infinity, -Infinity, -1, 0.5]
const inputs: unknown[] = [...invalid, 0, 1, 2, 50]

describe("MCP setting default invariant", () => {
	it("resolves each setting consistently and remains stable across repeated readers", () => {
		// Spec: McpToolSelectionLifecycle, SharedDefault.
		// Shared-default property: each reader uses the same
		// valid value or shared default, including when it receives resolved state.
		const resolve = (value: unknown, valid: number[], fallback: number) =>
			typeof value === "number" && valid.includes(value) ? value : fallback
		for (const threshold of inputs) {
			for (const initialK of inputs) {
				for (const searchTurns of inputs) {
					const resolved = resolveMcpDynamicLoadSettings(threshold, initialK, searchTurns)
					expect(resolved).toEqual({
						threshold: resolve(threshold, [0, 1, 2, 50], DEFAULT_MCP_DYNAMIC_LOAD_THRESHOLD),
						initialK: resolve(initialK, [1, 2, 50], DEFAULT_MCP_DYNAMIC_LOAD_INITIAL_K),
						searchTurns: resolve(searchTurns, [0, 1, 2, 50], DEFAULT_MCP_DYNAMIC_LOAD_SEARCH_TURNS),
					})
					expect(
						resolveMcpDynamicLoadSettings(resolved.threshold, resolved.initialK, resolved.searchTurns),
					).toEqual(resolved)
				}
			}
		}
	})
})
