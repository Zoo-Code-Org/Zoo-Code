import { describe, expect, it } from "vitest"

import {
	NESTED_DETECTION_MAX_DEPTH,
	NESTED_DETECTION_MAX_NODES,
	validateCwdParameter,
	validateNestedParams,
	VARIANT_CWD_OBJECT_MISUSE,
	VARIANT_NESTED_PARAM_OVERFLOW,
} from "../StructuralValidator"

describe("validateCwdParameter", () => {
	it("returns null when cwd is missing", () => {
		expect(validateCwdParameter({ command: "pnpm test" }, "execute_command")).toBeNull()
	})

	it("returns null when cwd is undefined", () => {
		expect(validateCwdParameter({ command: "pnpm test", cwd: undefined }, "execute_command")).toBeNull()
	})

	it("returns null when cwd is a string", () => {
		expect(validateCwdParameter({ command: "pnpm test", cwd: "src" }, "execute_command")).toBeNull()
	})

	it("returns null when cwd is an empty string", () => {
		expect(validateCwdParameter({ command: "pnpm test", cwd: "" }, "execute_command")).toBeNull()
	})

	it("flags a nested object in cwd", () => {
		const signal = validateCwdParameter({ command: "pnpm test", cwd: { command: "nested" } }, "execute_command")
		expect(signal).not.toBeNull()
		expect(signal?.source).toBe("validation")
		expect(signal?.stage).toBe("preflight")
		expect(signal?.toolName).toBe("execute_command")
		expect(signal?.metadata.variant).toBe(VARIANT_CWD_OBJECT_MISUSE)
		expect(signal?.metadata.parameter).toBe("cwd")
		expect(signal?.metadata.expectedType).toBe("string")
		expect(signal?.metadata.actualType).toBe("object")
	})

	it("flags an array in cwd", () => {
		const signal = validateCwdParameter({ command: "x", cwd: ["a"] }, "execute_command")
		expect(signal?.metadata.actualType).toBe("array")
	})

	it("flags a number in cwd", () => {
		const signal = validateCwdParameter({ command: "x", cwd: 42 }, "execute_command")
		expect(signal?.metadata.actualType).toBe("number")
	})

	it("flags a boolean in cwd", () => {
		const signal = validateCwdParameter({ command: "x", cwd: true }, "execute_command")
		expect(signal?.metadata.actualType).toBe("boolean")
	})

	it("flags null in cwd", () => {
		const signal = validateCwdParameter({ command: "x", cwd: null }, "execute_command")
		expect(signal?.metadata.actualType).toBe("null")
	})

	it("does not mutate the input arguments", () => {
		const args = { command: "x", cwd: { command: "y" } }
		const snapshot = JSON.stringify(args)
		validateCwdParameter(args, "execute_command")
		expect(JSON.stringify(args)).toBe(snapshot)
	})
})

describe("validateNestedParams", () => {
	it("returns null when args are plain scalars", () => {
		expect(validateNestedParams({ command: "pnpm test", cwd: "src" }, "execute_command")).toBeNull()
	})

	it("returns null for empty args", () => {
		expect(validateNestedParams({}, "execute_command")).toBeNull()
	})

	it("returns null for null and undefined values", () => {
		expect(validateNestedParams({ a: null, b: undefined, c: "x" }, "execute_command")).toBeNull()
	})

	it("flags a top-level object carrying a command signature", () => {
		const signal = validateNestedParams({ cwd: { command: "pnpm test" } }, "execute_command")
		expect(signal).not.toBeNull()
		expect(signal?.metadata.variant).toBe(VARIANT_NESTED_PARAM_OVERFLOW)
		expect(signal?.metadata.parameter).toBe("cwd")
		expect(signal?.metadata.structuralReason).toBe("nested-tool-input:command")
	})

	it("flags path+regex signature inside a scalar parameter", () => {
		const signal = validateNestedParams({ file_pattern: { path: "src", regex: "foo" } }, "search_files")
		expect(signal?.metadata.variant).toBe(VARIANT_NESTED_PARAM_OVERFLOW)
		expect(signal?.metadata.structuralReason).toBe("nested-tool-input:path+regex")
	})

	it("flags server_name+tool_name signature", () => {
		const signal = validateNestedParams({ args: { server_name: "s", tool_name: "t" } }, "some_tool")
		expect(signal?.metadata.structuralReason).toBe("nested-tool-input:server_name+tool_name")
	})

	it("flags an object with two known parameter keys", () => {
		const signal = validateNestedParams({ input: { path: "a", regex: "b" } }, "search_files")
		expect(signal).not.toBeNull()
	})

	it("does not flag a single known key on its own when it is not a tool signature", () => {
		const signal = validateNestedParams({ meta: { note: "x" } }, "some_tool")
		expect(signal).toBeNull()
	})

	it("allows read_file.indentation even though it is an object", () => {
		const signal = validateNestedParams(
			{
				path: "file.ts",
				indentation: {
					anchor_line: 10,
					max_levels: 0,
					include_siblings: false,
					include_header: true,
					max_lines: 200,
				},
			},
			"read_file",
		)
		expect(signal).toBeNull()
	})

	it("allows use_mcp_tool.arguments even though it is an object", () => {
		const signal = validateNestedParams(
			{
				server_name: "github",
				tool_name: "get_file_contents",
				arguments: { owner: "o", repo: "r", path: "p" },
			},
			"use_mcp_tool",
		)
		expect(signal).toBeNull()
	})

	it("does not flag plain strings that contain JSON-like text", () => {
		const signal = validateNestedParams({ command: 'echo {"path":"x","regex":"y"}' }, "execute_command")
		expect(signal).toBeNull()
	})

	it("detects a signature nested at depth 2", () => {
		const signal = validateNestedParams({ outer: { inner: { command: "x" } } }, "some_tool")
		expect(signal?.metadata.variant).toBe(VARIANT_NESTED_PARAM_OVERFLOW)
	})

	it("bounds recursion to NESTED_DETECTION_MAX_DEPTH", () => {
		let deep: Record<string, unknown> = { leaf: 1 }
		for (let i = 0; i < NESTED_DETECTION_MAX_DEPTH + 3; i += 1) {
			deep = { wrap: deep }
		}
		expect(NESTED_DETECTION_MAX_DEPTH).toBeGreaterThan(0)
		const signal = validateNestedParams({ outer: deep }, "some_tool")
		expect(signal).toBeNull()
	})

	it("bounds total visited nodes to NESTED_DETECTION_MAX_NODES", () => {
		const wide: Record<string, unknown> = {}
		for (let i = 0; i < NESTED_DETECTION_MAX_NODES + 10; i += 1) {
			wide[`k${i}`] = { child: i }
		}
		expect(NESTED_DETECTION_MAX_NODES).toBeGreaterThan(0)
		const signal = validateNestedParams({ outer: wide }, "some_tool")
		expect(signal).toBeNull()
	})

	it("flags cyclic structures safely without hanging", () => {
		const cyclic: Record<string, unknown> = { name: "x" }
		cyclic.self = cyclic
		const signal = validateNestedParams({ outer: cyclic }, "some_tool")
		expect(signal?.metadata.variant).toBe(VARIANT_NESTED_PARAM_OVERFLOW)
		expect(signal?.metadata.structuralReason).toBe("cyclic-structure")
	})

	it("does not mutate the input arguments", () => {
		const args = { outer: { inner: { command: "x" } } }
		const snapshot = JSON.stringify(args)
		validateNestedParams(args, "some_tool")
		expect(JSON.stringify(args)).toBe(snapshot)
	})
})
