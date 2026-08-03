import { describe, expect, it } from "vitest"

import {
	buildErrorSignature,
	buildStructuredErrorContent,
	deriveRecoveryDisposition,
	formatConciseErrorMessage,
	formatStructuredError,
	isRetryableError,
	isUserRejectionError,
	recordErrorOccurrence,
} from "../structuredError"

/**
 * Extracts and parses the JSON payload inside an <error_details> block.
 * Fails the test when the block is missing or the JSON is malformed.
 */
function parseDetails(content: string): Record<string, unknown> {
	const match = content.match(/^<error_details>\n([\s\S]*)\n<\/error_details>$/)
	if (!match) {
		throw new Error("expected an <error_details> block")
	}
	return JSON.parse(match[1]) as Record<string, unknown>
}

describe("formatStructuredError", () => {
	const baseDetails = {
		what: "An error occurred during executing command.",
		why: "Something failed.",
		next: ["First suggestion.", "Second suggestion."],
	}

	it("reflects the provided retry guidance fields", () => {
		const payload = parseDetails(
			formatStructuredError({
				...baseDetails,
				pattern: "TOOL_EXECUTION/ERROR_EXECUTION/001",
				retryable: false,
				occurrence: 2,
				disposition: "change_strategy",
			}),
		)
		expect(payload.retryable).toBe(false)
		expect(payload.occurrence).toBe(2)
		expect(payload.recovery_disposition).toBe("change_strategy")
		expect(payload.pattern_id).toBe("TOOL_EXECUTION/ERROR_EXECUTION/001")
	})

	it("produces a type string without slashes", () => {
		const payload = parseDetails(
			formatStructuredError({ ...baseDetails, pattern: "TOOL_EXECUTION/ERROR_EXECUTION/001" }),
		)
		expect(payload.type).toBe("tool_execution.error_execution.001")
		expect(String(payload.type)).not.toContain("/")
	})

	it("clamps occurrence to at least 1", () => {
		const payload = parseDetails(formatStructuredError({ ...baseDetails, occurrence: 0 }))
		expect(payload.occurrence).toBe(1)
	})

	it("keeps the JSON valid when the payload exceeds the byte limit", () => {
		const content = formatStructuredError(
			{
				what: `what-${"x".repeat(500)}`,
				why: `why-${"y".repeat(500)}`,
				next: ["first", "second", "third"],
				pattern: "TOOL_EXECUTION/ERROR_EXECUTION/001",
			},
			400,
		)
		// parseDetails asserts both the wrapper shape and JSON.parse success.
		const payload = parseDetails(content)
		expect(payload.pattern_id).toBe("TOOL_EXECUTION/ERROR_EXECUTION/001")
	})

	it("falls back to a minimal valid payload under a pathological byte limit", () => {
		const content = formatStructuredError({ ...baseDetails }, 50)
		const payload = parseDetails(content)
		expect(payload.what).toBe("Error.")
		expect(payload.next).toEqual([])
	})
})

describe("isRetryableError", () => {
	it("marks terminal/shell/provider-switch machine codes as non-retryable", () => {
		expect(isRetryableError(new Error("TERMINAL/PROVIDER_SWITCH/003 provider switch failed"))).toBe(false)
		expect(isRetryableError(new Error("SHELL/INTEGRATION/001 shell channel unavailable"))).toBe(false)
		expect(isRetryableError(new Error("failed: PROVIDER_SWITCH requested mid-run"))).toBe(false)
	})

	it("marks validation errors as non-retryable", () => {
		const zodLike = new Error("invalid arguments")
		zodLike.name = "ZodError"
		expect(isRetryableError(zodLike)).toBe(false)
		expect(isRetryableError(new Error("Input validation failed for tool read_file"))).toBe(false)
	})

	it("marks user rejections as non-retryable", () => {
		expect(isRetryableError(new Error("Changes were rejected by the user."))).toBe(false)
		expect(isRetryableError(new Error("Delete operation was denied by the user."))).toBe(false)
	})

	it("treats ordinary execution errors as retryable", () => {
		expect(isRetryableError(new Error("ENOENT: no such file or directory"))).toBe(true)
		expect(isRetryableError(new Error("network timeout"))).toBe(true)
	})
})

describe("isUserRejectionError", () => {
	it("detects rejection phrasing", () => {
		expect(isUserRejectionError(new Error("Changes were rejected by the user."))).toBe(true)
	})
	it("does not flag unrelated errors", () => {
		expect(isUserRejectionError(new Error("TERMINAL/PROVIDER_SWITCH/003"))).toBe(false)
	})
})

describe("deriveRecoveryDisposition", () => {
	it("returns correct_once for a retryable first failure", () => {
		expect(deriveRecoveryDisposition(new Error("boom"), 1)).toBe("correct_once")
	})

	it("escalates retryable errors to change_strategy at the stuck threshold", () => {
		expect(deriveRecoveryDisposition(new Error("boom"), 3)).toBe("change_strategy")
		expect(deriveRecoveryDisposition(new Error("boom"), 5)).toBe("change_strategy")
	})

	it("returns change_strategy for non-retryable errors", () => {
		expect(deriveRecoveryDisposition(new Error("TERMINAL/PROVIDER_SWITCH/003"), 1)).toBe("change_strategy")
	})

	it("returns await_user for user rejections", () => {
		expect(deriveRecoveryDisposition(new Error("Changes were rejected by the user."), 1)).toBe("await_user")
	})
})

describe("recordErrorOccurrence", () => {
	it("counts repeated identical failures per task", () => {
		const task = { id: "task-occ-1" }
		const error = new Error("TERMINAL/PROVIDER_SWITCH/003 provider switch failed")
		const signature = buildErrorSignature("executing command", error)
		expect(recordErrorOccurrence(task, signature)).toBe(1)
		expect(recordErrorOccurrence(task, signature)).toBe(2)
		expect(recordErrorOccurrence(task, signature)).toBe(3)
	})

	it("tracks different error signatures independently", () => {
		const task = { id: "task-occ-2" }
		const sigA = buildErrorSignature("executing command", new Error("error A"))
		const sigB = buildErrorSignature("executing command", new Error("error B"))
		expect(recordErrorOccurrence(task, sigA)).toBe(1)
		expect(recordErrorOccurrence(task, sigB)).toBe(1)
		expect(recordErrorOccurrence(task, sigA)).toBe(2)
	})

	it("does not leak occurrences across tasks", () => {
		const taskA = { id: "task-occ-3a" }
		const taskB = { id: "task-occ-3b" }
		const signature = buildErrorSignature("executing command", new Error("same error"))
		expect(recordErrorOccurrence(taskA, signature)).toBe(1)
		expect(recordErrorOccurrence(taskB, signature)).toBe(1)
	})

	it("fails open with occurrence 1 for non-object task keys instead of throwing", () => {
		// Double assertion is required to simulate the caller mistake this
		// guards against: passing a string taskId where a Task object is
		// expected. There is no typed way to express that mistake.
		const notATask = "task-id" as unknown as object
		expect(() => recordErrorOccurrence(notATask, "sig")).not.toThrow()
		// Ephemeral state: counters never persist for invalid keys.
		expect(recordErrorOccurrence(notATask, "sig")).toBe(1)
		expect(recordErrorOccurrence(notATask, "sig")).toBe(1)
	})
})

describe("buildStructuredErrorContent", () => {
	it("reports a first occurrence as retryable correct_once for ordinary errors", () => {
		const task = { id: "task-bsec-1" }
		const payload = parseDetails(
			buildStructuredErrorContent(
				task,
				"executing command",
				new Error("boom"),
				"TOOL_EXECUTION/ERROR_EXECUTION/002",
			),
		)
		expect(payload.retryable).toBe(true)
		expect(payload.occurrence).toBe(1)
		expect(payload.recovery_disposition).toBe("correct_once")
	})

	it("marks terminal provider-switch failures as non-retryable from the first occurrence", () => {
		const task = { id: "task-bsec-2" }
		const payload = parseDetails(
			buildStructuredErrorContent(
				task,
				"executing command",
				new Error("TERMINAL/PROVIDER_SWITCH/003 provider switch failed"),
				"TOOL_EXECUTION/ERROR_EXECUTION/002",
			),
		)
		expect(payload.retryable).toBe(false)
		expect(payload.occurrence).toBe(1)
		expect(payload.recovery_disposition).toBe("change_strategy")
	})

	it("escalates repeated identical failures to change_strategy at the stuck threshold", () => {
		const task = { id: "task-bsec-3" }
		const error = new Error("identical failure")
		buildStructuredErrorContent(task, "executing command", error, "TOOL_EXECUTION/ERROR_EXECUTION/002")
		const second = parseDetails(
			buildStructuredErrorContent(task, "executing command", error, "TOOL_EXECUTION/ERROR_EXECUTION/002"),
		)
		expect(second.occurrence).toBe(2)
		expect(second.recovery_disposition).toBe("correct_once")

		const third = parseDetails(
			buildStructuredErrorContent(task, "executing command", error, "TOOL_EXECUTION/ERROR_EXECUTION/002"),
		)
		expect(third.occurrence).toBe(3)
		expect(third.recovery_disposition).toBe("change_strategy")
	})
})

describe("formatConciseErrorMessage", () => {
	it("produces a single-line human message without the structured payload", () => {
		const message = formatConciseErrorMessage("executing command", new Error("boom"))
		expect(message).toContain("executing command")
		expect(message).toContain("boom")
		expect(message).not.toContain("<error_details>")
	})

	it("handles errors with an empty message", () => {
		expect(formatConciseErrorMessage("executing command", new Error())).toContain("An unexpected error occurred.")
	})
})
