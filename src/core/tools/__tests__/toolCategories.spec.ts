// Run: cd src && npx vitest run core/tools/__tests__/toolCategories.spec.ts

import { isReadOnlyTool, partitionToolsForExecution, READ_ONLY_TOOLS } from "../toolCategories"

describe("READ_ONLY_TOOLS", () => {
	it("contains the four canonical read-only tools", () => {
		expect(READ_ONLY_TOOLS.has("read_file")).toBe(true)
		expect(READ_ONLY_TOOLS.has("list_files")).toBe(true)
		expect(READ_ONLY_TOOLS.has("search_files")).toBe(true)
		expect(READ_ONLY_TOOLS.has("codebase_search")).toBe(true)
	})

	it("does not contain write or interactive tools", () => {
		expect(READ_ONLY_TOOLS.has("write_to_file" as any)).toBe(false)
		expect(READ_ONLY_TOOLS.has("apply_diff" as any)).toBe(false)
		expect(READ_ONLY_TOOLS.has("execute_command" as any)).toBe(false)
		expect(READ_ONLY_TOOLS.has("attempt_completion" as any)).toBe(false)
	})
})

describe("isReadOnlyTool", () => {
	it("returns true for read_file", () => {
		expect(isReadOnlyTool("read_file")).toBe(true)
	})

	it("returns true for list_files", () => {
		expect(isReadOnlyTool("list_files")).toBe(true)
	})

	it("returns true for search_files", () => {
		expect(isReadOnlyTool("search_files")).toBe(true)
	})

	it("returns true for codebase_search", () => {
		expect(isReadOnlyTool("codebase_search")).toBe(true)
	})

	it("returns false for write_to_file", () => {
		expect(isReadOnlyTool("write_to_file")).toBe(false)
	})

	it("returns false for apply_diff", () => {
		expect(isReadOnlyTool("apply_diff")).toBe(false)
	})

	it("returns false for execute_command", () => {
		expect(isReadOnlyTool("execute_command")).toBe(false)
	})

	it("returns false for attempt_completion", () => {
		expect(isReadOnlyTool("attempt_completion")).toBe(false)
	})

	it("returns false for new_task", () => {
		expect(isReadOnlyTool("new_task")).toBe(false)
	})

	it("returns false for use_mcp_tool", () => {
		expect(isReadOnlyTool("use_mcp_tool")).toBe(false)
	})

	it("returns false for an unknown/arbitrary string", () => {
		expect(isReadOnlyTool("unknown_tool")).toBe(false)
		expect(isReadOnlyTool("")).toBe(false)
	})
})

describe("partitionToolsForExecution", () => {
	it("returns an empty array for an empty input", () => {
		expect(partitionToolsForExecution([])).toEqual([])
	})

	it("returns a single sequential group for a single write tool", () => {
		const tools = [{ name: "write_to_file" }]
		const result = partitionToolsForExecution(tools)
		expect(result).toEqual([{ batch: [{ name: "write_to_file" }], parallel: false }])
	})

	it("returns a single non-parallel group for a single read-only tool", () => {
		const tools = [{ name: "read_file" }]
		const result = partitionToolsForExecution(tools)
		expect(result).toEqual([{ batch: [{ name: "read_file" }], parallel: false }])
	})

	it("returns one parallel batch for all read-only tools", () => {
		const tools = [
			{ name: "read_file" },
			{ name: "list_files" },
			{ name: "search_files" },
			{ name: "codebase_search" },
		]
		const result = partitionToolsForExecution(tools)
		expect(result).toHaveLength(1)
		expect(result[0].parallel).toBe(true)
		expect(result[0].batch).toHaveLength(4)
	})

	it("returns individual sequential groups for all write tools", () => {
		const tools = [{ name: "write_to_file" }, { name: "apply_diff" }, { name: "execute_command" }]
		const result = partitionToolsForExecution(tools)
		expect(result).toHaveLength(3)
		expect(result.every((g) => g.parallel === false)).toBe(true)
		expect(result.every((g) => g.batch.length === 1)).toBe(true)
	})

	it("batches leading read-only tools, then sequential write, then trailing read-only batch", () => {
		// [read_file, read_file, write_to_file, read_file]
		const tools = [
			{ name: "read_file" },
			{ name: "list_files" },
			{ name: "write_to_file" },
			{ name: "search_files" },
		]
		const result = partitionToolsForExecution(tools)
		expect(result).toHaveLength(3)

		// First group: two read-only tools → parallel
		expect(result[0].parallel).toBe(true)
		expect(result[0].batch.map((t) => t.name)).toEqual(["read_file", "list_files"])

		// Second group: write tool → sequential
		expect(result[1].parallel).toBe(false)
		expect(result[1].batch.map((t) => t.name)).toEqual(["write_to_file"])

		// Third group: single read-only tool → NOT parallel (batch.length === 1)
		expect(result[2].parallel).toBe(false)
		expect(result[2].batch.map((t) => t.name)).toEqual(["search_files"])
	})

	it("produces non-parallel group for exactly two consecutive read-only tools separated by writes", () => {
		// [read_file, write_to_file, read_file, read_file]
		const tools = [
			{ name: "read_file" },
			{ name: "write_to_file" },
			{ name: "list_files" },
			{ name: "codebase_search" },
		]
		const result = partitionToolsForExecution(tools)
		expect(result).toHaveLength(3)

		// First group: single read-only → not parallel
		expect(result[0].parallel).toBe(false)
		expect(result[0].batch).toHaveLength(1)

		// Second group: write tool → not parallel
		expect(result[1].parallel).toBe(false)

		// Third group: two consecutive read-only → parallel
		expect(result[2].parallel).toBe(true)
		expect(result[2].batch).toHaveLength(2)
	})

	it("handles write tool surrounded by read-only tools creating three groups", () => {
		const tools = [{ name: "codebase_search" }, { name: "apply_diff" }, { name: "read_file" }]
		const result = partitionToolsForExecution(tools)
		expect(result).toHaveLength(3)
		expect(result[0]).toEqual({ batch: [{ name: "codebase_search" }], parallel: false })
		expect(result[1]).toEqual({ batch: [{ name: "apply_diff" }], parallel: false })
		expect(result[2]).toEqual({ batch: [{ name: "read_file" }], parallel: false })
	})

	it("preserves original tool objects in batches (no mutation)", () => {
		const t1 = { name: "read_file", id: "abc" }
		const t2 = { name: "list_files", id: "def" }
		const result = partitionToolsForExecution([t1, t2])
		expect(result[0].batch[0]).toBe(t1)
		expect(result[0].batch[1]).toBe(t2)
	})

	it("correctly handles attempt_completion as sequential", () => {
		const tools = [{ name: "attempt_completion" }]
		const result = partitionToolsForExecution(tools)
		expect(result).toHaveLength(1)
		expect(result[0].parallel).toBe(false)
	})
})
