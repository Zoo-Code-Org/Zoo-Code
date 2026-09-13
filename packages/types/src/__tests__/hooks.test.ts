import {
	DEFAULT_HOOK_DEFINITIONS,
	HOOK_CAPTURE_MAX_BYTES,
	HOOK_CAPTURE_TRUNCATION_MARKER,
	HOOK_MODEL_OUTPUT_MAX_BYTES,
	HOOK_MODEL_TRUNCATION_MARKER,
	HOOK_TIMEOUT_MS,
	classifyHookExit,
	findDuplicateHookDefinitionIds,
	getMatchingHooks,
	hookDefinitionSchema,
	hookDefinitionsSchema,
	hookInvocationSchema,
	sanitizeHookOutput,
	truncateHookCaptureOutput,
	truncateHookModelOutput,
	type HookDefinition,
} from "../hooks.js"
import { clineMessageSchema, clineSaySchema } from "../message.js"

const encoder = new TextEncoder()

const sessionHook: HookDefinition = {
	id: "session",
	name: "Session setup",
	enabled: true,
	phase: "sessionStart",
	executable: "/usr/bin/env",
	argv: ["node", "setup.js"],
}

const preToolHook: HookDefinition = {
	id: "pre-read",
	name: "Check reads",
	enabled: true,
	phase: "preToolUse",
	toolMatcher: ["read_file", "list_files"],
	executable: "node",
	argv: ["check.js"],
}

describe("hook definition contracts", () => {
	it("accepts separate executables and argument arrays", () => {
		expect(hookDefinitionSchema.parse(preToolHook)).toEqual(preToolHook)
		expect(HOOK_TIMEOUT_MS).toBe(10_000)
	})

	it("enforces phase-specific exact tool matchers", () => {
		expect(hookDefinitionSchema.safeParse({ ...sessionHook, toolMatcher: ["read_file"] }).success).toBe(false)
		expect(hookDefinitionSchema.safeParse({ ...preToolHook, toolMatcher: [] }).success).toBe(false)
		expect(hookDefinitionSchema.safeParse({ ...preToolHook, toolMatcher: ["read"] }).success).toBe(false)
	})

	it("rejects NUL characters in executables and arguments", () => {
		expect(hookDefinitionSchema.safeParse({ ...sessionHook, executable: "node\0evil" }).success).toBe(false)
		expect(hookDefinitionSchema.safeParse({ ...sessionHook, argv: ["safe", "bad\0arg"] }).success).toBe(false)
	})

	it("rejects duplicate IDs and exposes a reusable duplicate helper", () => {
		expect(findDuplicateHookDefinitionIds([sessionHook, preToolHook, { ...preToolHook, id: "session" }])).toEqual([
			"session",
		])
		expect(hookDefinitionsSchema.safeParse([sessionHook, { ...preToolHook, id: sessionHook.id }]).success).toBe(
			false,
		)
	})

	it("provides one immutable empty default", () => {
		expect(DEFAULT_HOOK_DEFINITIONS).toEqual([])
		expect(Object.isFrozen(DEFAULT_HOOK_DEFINITIONS)).toBe(true)
	})
})

describe("hook invocation contract", () => {
	it("requires only a tool name for pre-tool invocations", () => {
		const invocation = {
			version: 1,
			hookRunId: "run-1",
			phase: "preToolUse",
			taskId: "task-1",
			instanceId: "instance-1",
			workspacePath: "/workspace",
			tool: { name: "read_file" },
		} as const

		expect(hookInvocationSchema.parse(invocation)).toEqual(invocation)
		expect(hookInvocationSchema.safeParse({ ...invocation, tool: undefined }).success).toBe(false)
	})
})

describe("hook matching", () => {
	it("returns enabled matching hooks in configured order", () => {
		const later = { ...preToolHook, id: "later", name: "Later" }
		const disabled = { ...preToolHook, id: "disabled", enabled: false }
		const definitions = [sessionHook, later, disabled, preToolHook]

		expect(getMatchingHooks(definitions, "sessionStart")).toEqual([sessionHook])
		expect(getMatchingHooks(definitions, "preToolUse", "read_file")).toEqual([later, preToolHook])
		expect(getMatchingHooks(definitions, "preToolUse", "write_to_file")).toEqual([])
	})
})

describe("hook exit policy", () => {
	it("keeps every session-start failure nonfatal", () => {
		expect(classifyHookExit("sessionStart", 0)).toEqual({ status: "succeeded", decision: "continue" })
		expect(classifyHookExit("sessionStart", 2)).toEqual({ status: "failed", decision: "continue" })
		expect(classifyHookExit("sessionStart", null)).toEqual({ status: "failed", decision: "continue" })
	})

	it("allows zero, blocks two, and fails closed otherwise before tools", () => {
		expect(classifyHookExit("preToolUse", 0)).toEqual({ status: "succeeded", decision: "allow" })
		expect(classifyHookExit("preToolUse", 2)).toEqual({ status: "blocked", decision: "block" })
		expect(classifyHookExit("preToolUse", 1)).toEqual({ status: "failed", decision: "block" })
		expect(classifyHookExit("preToolUse", null)).toEqual({ status: "failed", decision: "block" })
	})
})

describe("hook output policy", () => {
	it("caps capture output at 64 KiB with an explicit marker", () => {
		const result = truncateHookCaptureOutput("a".repeat(HOOK_CAPTURE_MAX_BYTES + 100))

		expect(result.truncated).toBe(true)
		expect(result.output.endsWith(HOOK_CAPTURE_TRUNCATION_MARKER)).toBe(true)
		expect(encoder.encode(result.output).length).toBeLessThanOrEqual(HOOK_CAPTURE_MAX_BYTES)
		expect(result.omittedBytes).toBeGreaterThan(0)
	})

	it("preserves the beginning and end within the 16 KiB model cap", () => {
		const output = `BEGIN-${"x".repeat(HOOK_MODEL_OUTPUT_MAX_BYTES)}-END`
		const result = truncateHookModelOutput(output)

		expect(result.output.startsWith("BEGIN-")).toBe(true)
		expect(result.output.endsWith("-END")).toBe(true)
		expect(result.output).toContain(HOOK_MODEL_TRUNCATION_MARKER)
		expect(encoder.encode(result.output).length).toBeLessThanOrEqual(HOOK_MODEL_OUTPUT_MAX_BYTES)
	})

	it("truncates multibyte output only at valid UTF-8 boundaries", () => {
		const result = truncateHookModelOutput("🐘".repeat(HOOK_MODEL_OUTPUT_MAX_BYTES))

		expect(result.output).not.toContain("�")
		expect(encoder.encode(result.output).length).toBeLessThanOrEqual(HOOK_MODEL_OUTPUT_MAX_BYTES)
	})

	it("removes terminal escapes and unsafe control characters", () => {
		expect(sanitizeHookOutput("\u001b[31mred\u001b[0m\0\u0007\nnext")).toBe("red\nnext")
	})
})

describe("hook messages", () => {
	it("accepts hook say messages with structured payloads", () => {
		const message = {
			ts: 1,
			type: "say",
			say: "hook",
			hook: {
				hookRunId: "run-1",
				hookId: "pre-read",
				name: "Check reads",
				phase: "preToolUse",
				status: "blocked",
				matchedTool: "read_file",
				outputSummary: "blocked by policy",
				startedAt: 1,
				completedAt: 2,
			},
		} as const

		expect(clineSaySchema.parse("hook")).toBe("hook")
		expect(clineMessageSchema.parse(message)).toEqual(message)
	})
})
