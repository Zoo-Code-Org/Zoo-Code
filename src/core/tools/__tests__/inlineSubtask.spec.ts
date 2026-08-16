// npx vitest run core/tools/__tests__/inlineSubtask.spec.ts

import { describe, it, expect } from "vitest"
import type { TodoItem } from "@roo-code/types"
import { decideInlineFlatten, buildInlineDirective } from "../inlineSubtask"

const todos: TodoItem[] = [
	{ content: "step one", status: "pending" },
	{ content: "step two", status: "completed" },
] as unknown as TodoItem[]

describe("decideInlineFlatten (pure decision)", () => {
	it("delegates normally when within the limit", () => {
		const d = decideInlineFlatten({
			childDepth: 2,
			maxNestingDepth: 2,
			autoFlattenOnLimit: true,
			inlineActive: false,
			message: "m",
			todos,
		})
		expect(d).toEqual({ action: "delegate" })
	})

	it("delegates when exactly at the limit (childDepth === max)", () => {
		const d = decideInlineFlatten({
			childDepth: 2,
			maxNestingDepth: 2,
			autoFlattenOnLimit: true,
			inlineActive: false,
			message: "m",
			todos,
		})
		expect(d.action).toBe("delegate")
	})

	it("flattens when over the limit and autoFlattenOnLimit is true", () => {
		const d = decideInlineFlatten({
			childDepth: 3,
			maxNestingDepth: 2,
			autoFlattenOnLimit: true,
			inlineActive: false,
			message: "do X",
			todos,
		})
		expect(d.action).toBe("flatten")
		if (d.action === "flatten") {
			expect(d.directive).toContain("auto-flattened")
			expect(d.directive).toContain("nesting limit 2 reached")
			expect(d.directive).toContain("do X")
		}
	})

	it("rejects when over the limit and autoFlattenOnLimit is false", () => {
		const d = decideInlineFlatten({
			childDepth: 3,
			maxNestingDepth: 2,
			autoFlattenOnLimit: false,
			inlineActive: false,
			message: "m",
			todos,
		})
		expect(d.action).toBe("reject-limit")
		if (d.action === "reject-limit") {
			expect(d.message).toContain("auto-flatten is disabled")
		}
	})

	it("treats maxNestingDepth 0 as delegation-disabled → always flatten when over", () => {
		const d = decideInlineFlatten({
			childDepth: 1,
			maxNestingDepth: 0,
			autoFlattenOnLimit: true,
			inlineActive: false,
			message: "m",
			todos,
		})
		expect(d.action).toBe("flatten")
	})

	it("rejects a nested new_task while an inline phase is active (precedence over delegate)", () => {
		const d = decideInlineFlatten({
			childDepth: 1,
			maxNestingDepth: 5,
			autoFlattenOnLimit: true,
			inlineActive: true,
			message: "m",
			todos,
		})
		expect(d.action).toBe("reject-nested")
	})

	it("rejects a nested new_task while active even when over the limit (nested wins)", () => {
		const d = decideInlineFlatten({
			childDepth: 9,
			maxNestingDepth: 2,
			autoFlattenOnLimit: true,
			inlineActive: true,
			message: "m",
			todos,
		})
		expect(d.action).toBe("reject-nested")
	})

	it("includes todos in the flatten directive when present", () => {
		const d = decideInlineFlatten({
			childDepth: 3,
			maxNestingDepth: 2,
			autoFlattenOnLimit: true,
			inlineActive: false,
			message: "m",
			todos,
		})
		if (d.action === "flatten") {
			expect(d.directive).toContain("step one")
			expect(d.directive).toContain("step two")
		}
	})

	it("omits the Todos section when no todos are provided", () => {
		const d = decideInlineFlatten({
			childDepth: 3,
			maxNestingDepth: 2,
			autoFlattenOnLimit: true,
			inlineActive: false,
			message: "m",
			todos: [],
		})
		if (d.action === "flatten") {
			expect(d.directive).not.toContain("Todos:")
		}
	})
})

describe("buildInlineDirective", () => {
	it("embeds the instruction and todos", () => {
		const dir = buildInlineDirective("fix the bug", todos, 2)
		expect(dir).toContain("fix the bug")
		expect(dir).toContain("step one")
	})

	it("instructs to call attempt_completion when done", () => {
		const dir = buildInlineDirective("m", [], 3)
		expect(dir).toContain("attempt_completion")
	})
})
