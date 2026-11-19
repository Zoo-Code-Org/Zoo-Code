import { describe, expect, it } from "vitest"
import {
	DEFAULT_MCP_DYNAMIC_LOAD_INITIAL_K,
	DEFAULT_MCP_DYNAMIC_LOAD_THRESHOLD,
	resolveMcpDynamicLoadSettings,
} from "../mcp.js"

const invalid: unknown[] = [undefined, null, "2", {}, [], NaN, Infinity, -Infinity, -1, 0.5]
const inputs: unknown[] = [...invalid, 0, 1, 2, 50]

describe("MCP setting default invariant", () => {
	it("resolves both settings consistently and remains stable across repeated readers", () => {
		// Shared-default property: each reader uses the same
		// valid value or shared default, including when it receives resolved state.
		for (const threshold of inputs) {
			for (const initialK of inputs) {
				const resolved = resolveMcpDynamicLoadSettings(threshold, initialK)
				expect(resolved).toEqual({
					threshold:
						typeof threshold === "number" && [0, 1, 2, 50].includes(threshold)
							? threshold
							: DEFAULT_MCP_DYNAMIC_LOAD_THRESHOLD,
					initialK:
						typeof initialK === "number" && [1, 2, 50].includes(initialK)
							? initialK
							: DEFAULT_MCP_DYNAMIC_LOAD_INITIAL_K,
				})
				expect(resolveMcpDynamicLoadSettings(resolved.threshold, resolved.initialK)).toEqual(resolved)
			}
		}
	})
})
