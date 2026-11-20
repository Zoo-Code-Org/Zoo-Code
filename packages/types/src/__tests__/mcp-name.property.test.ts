import { describe, expect, it } from "vitest"
import { attachedMcpToolNamesSchema } from "../history.js"
import { isCanonicalMcpToolName } from "../mcp.js"

describe("MCP attachment name boundary invariant", () => {
	it("accepts generated full and truncated names through validation and restoration", () => {
		for (const server of ["a", "_", "my-server", "my_server", "s".repeat(70)]) {
			for (const tool of ["b", "_", "get-info", "get_info", "t".repeat(70)]) {
				for (const length of [1, 50, 55, 56, 57, 58, 59, 60, 64, 65]) {
					const name = `mcp--${server.repeat(length)}--${tool}`.slice(0, 64)
					expect(isCanonicalMcpToolName(name), name).toBe(true)
					expect(attachedMcpToolNamesSchema.parse([name])).toEqual([name])
				}
			}
		}
	})

	it("rejects oversized names through validation and restoration regardless of matcher content", () => {
		for (const length of [65, 66, 128, 4096]) {
			for (const prefix of ["mcp--a--", "mcp--A--A--A--"]) {
				const name = prefix + "a".repeat(length - prefix.length)
				for (const suffix of ["", "!"]) {
					expect(isCanonicalMcpToolName(name + suffix)).toBe(false)
					expect(attachedMcpToolNamesSchema.parse([name + suffix])).toBeUndefined()
				}
			}
		}
	})

	it.each(["", "xmcp--a--b", "mcp--1--b", "mcp--a--1", "mcp--a--", "mcp__a__b", "mcp--a--b!"])(
		"rejects malformed attachment %j through both entry points",
		(name) => {
			expect(isCanonicalMcpToolName(name)).toBe(false)
			expect(attachedMcpToolNamesSchema.parse([name])).toBeUndefined()
		},
	)
})
