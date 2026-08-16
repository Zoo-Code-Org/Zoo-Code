// npx vitest core/task/__tests__/taskDepth.spec.ts

import { computeTaskDepth, MAX_DEPTH_WALK } from "../taskDepth"

describe("computeTaskDepth", () => {
	it("returns a valid persisted depth as-is", () => {
		expect(computeTaskDepth("a", 3, () => undefined)).toBe(3)
	})

	it("rejects non-integer / negative persisted depths and falls through to the walk", () => {
		// ownDepth invalid -> walk; no parent -> root at depth 0
		expect(computeTaskDepth("a", -1, (id) => ({ parentTaskId: undefined }))).toBe(0)
		expect(computeTaskDepth("a", 1.5, (id) => ({ parentTaskId: undefined }))).toBe(0)
	})

	it("derives depth from a live root with no persisted value", () => {
		// c -> b -> a(root). No depths persisted anywhere.
		const lookup = (id: string) => {
			switch (id) {
				case "c":
					return { parentTaskId: "b" }
				case "b":
					return { parentTaskId: "a" }
				case "a":
					return { parentTaskId: undefined }
			}
			return undefined
		}
		expect(computeTaskDepth("c", undefined, lookup)).toBe(2)
	})

	it("derives depth from the nearest ancestor with a persisted value", () => {
		// c -> b(depth 5) -> a. Only b has a persisted depth.
		const lookup = (id: string) => {
			switch (id) {
				case "c":
					return { parentTaskId: "b" }
				case "b":
					return { parentTaskId: "a", depth: 5 }
				case "a":
					return { parentTaskId: undefined, depth: 4 }
			}
			return undefined
		}
		expect(computeTaskDepth("c", undefined, lookup)).toBe(6)
	})

	it("returns undefined for a cycle in the parent chain", () => {
		const lookup = (id: string) => {
			switch (id) {
				case "a":
					return { parentTaskId: "b" }
				case "b":
					return { parentTaskId: "c" }
				case "c":
					return { parentTaskId: "a" } // cycle
			}
			return undefined
		}
		expect(computeTaskDepth("a", undefined, lookup)).toBeUndefined()
	})

	it("returns undefined when the chain dangles (parent not loadable)", () => {
		const lookup = (id: string) => {
			if (id === "c") return { parentTaskId: "missing" }
			return undefined // "missing" cannot be loaded
		}
		expect(computeTaskDepth("c", undefined, lookup)).toBeUndefined()
	})

	it("returns undefined for a chain longer than MAX_DEPTH_WALK hops", () => {
		// Build a linear chain of length > MAX_DEPTH_WALK with no persisted depths.
		const nodes: Record<string, { parentTaskId?: string }> = {}
		for (let i = 0; i < MAX_DEPTH_WALK + 5; i++) {
			nodes[`t${i}`] = { parentTaskId: i === 0 ? undefined : `t${i - 1}` }
		}
		const lookup = (id: string) => nodes[id]
		expect(computeTaskDepth(`t${MAX_DEPTH_WALK + 4}`, undefined, lookup)).toBeUndefined()
	})

	it("handles a self-referencing parent", () => {
		const lookup = (id: string) => ({ parentTaskId: id })
		expect(computeTaskDepth("a", undefined, lookup)).toBeUndefined()
	})
})
