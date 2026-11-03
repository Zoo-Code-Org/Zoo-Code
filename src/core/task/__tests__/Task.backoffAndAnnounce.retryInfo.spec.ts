// npx vitest run core/task/__tests__/Task.backoffAndAnnounce.retryInfo.spec.ts

import { describe, expect, it, vi } from "vitest"

import { createRateLimitClock } from "../RateLimitClock"
import { Task } from "../Task"

// Resolve every countdown tick instantly so the observable behavior (the say()
// call sequence) is asserted without real sleeps. Same mock as reasoning-preservation.
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

/**
 * Structural twin of the private `BackoffApiError` interface in Task.ts: an Error with
 * the optional HTTP status and Google-RPC-style errorDetails array (RetryInfo on 429).
 * Kept local and exact so the call through the bracket-notation seam type-checks
 * against the private parameter without `as any`.
 */
type RetryApiError = Error & {
	status?: number
	errorDetails?: { "@type"?: string; retryDelay?: string }[]
}

const RETRY_INFO_TYPE = "type.googleapis.com/google.rpc.RetryInfo"

/**
 * `Task.backoffAndAnnounce` is private; the specs drive it through the same
 * bracket-notation prototype seam used by `ask-allowlist-cwd.spec.ts` (no production
 * visibility change). The countdown duration is observable: `say("api_req_retry_delayed",
 * "<status>\n<message>\n<retry_timer>N</retry_timer>", undefined, true)` is called once
 * per remaining second starting at N = finalDelay, followed by a final non-partial say.
 * Asserting the exact first timer value and total call count pins the RetryInfo
 * extraction predicate on Task.ts L4931-L4933 (REQ-005 gate: NoCoverage region R4).
 */
function buildTask(): { task: Task; sayMock: ReturnType<typeof vi.fn> } {
	const task = Object.create(Task.prototype) as Task
	task["abort"] = false
	task["rateLimitClock"] = createRateLimitClock()
	const sayMock = vi.fn().mockResolvedValue(undefined)
	task.say = sayMock
	// A double assertion is unavoidable here: `providerRef` is a `WeakRef<ClineProvider>`,
	// and the stub is neither a `WeakRef` nor a whole `ClineProvider`. Constructing
	// either would drag in the extension host, when `backoffAndAnnounce` only ever calls
	// `deref()` and `getState()` on it. getState() returns no requestDelaySeconds, so the
	// base backoff is the documented 5 seconds.
	task["providerRef"] = { deref: () => ({ getState: async () => ({}) }) } as unknown as Task["providerRef"]
	return { task, sayMock }
}

/** Countdown text stamped with the seconds remaining on each partial say(). */
function timerOf(call: unknown[]): string | undefined {
	const text = call[1]
	return typeof text === "string" ? text : undefined
}

describe("Task.backoffAndAnnounce RetryInfo extraction", () => {
	it("uses the provider RetryInfo delay (seconds + 1) on a 429 instead of the exponential backoff", async () => {
		const { task, sayMock } = buildTask()
		const error: RetryApiError = Object.assign(new Error("rate limited"), {
			status: 429,
			errorDetails: [{ "@type": RETRY_INFO_TYPE, retryDelay: "7s" }],
		})

		await task["backoffAndAnnounce"](0, error)

		// Correct code: RetryInfo found → exponentialDelay = 7 + 1 = 8 (beats the
		// default baseDelay*2^0 = 5). Predicate mutants that fail the lookup
		// (ArrowFunction→undefined, condition→false, flipped ===, either string
		// literal→"") fall back to 5 and break these assertions.
		const calls = sayMock.mock.calls
		expect(calls).toHaveLength(9) // 8 countdown ticks + 1 final non-partial
		expect(calls[0]).toEqual([
			"api_req_retry_delayed",
			"429\nrate limited\n<retry_timer>8</retry_timer>",
			undefined,
			true,
		])
		expect(calls[7][1]).toContain("<retry_timer>1</retry_timer>")
		expect(calls[8]).toEqual(["api_req_retry_delayed", "429\nrate limited\n", undefined, false])
	})

	it("finds the RetryInfo entry even when it is not the first errorDetail", async () => {
		const { task, sayMock } = buildTask()
		const error: RetryApiError = Object.assign(new Error("rate limited"), {
			status: 429,
			errorDetails: [
				{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "rateLimitExceeded" },
				{ "@type": RETRY_INFO_TYPE, retryDelay: "7s" },
			],
		})

		await task["backoffAndAnnounce"](0, error)

		// A predicate mutated to `() => true` would stop at the first detail (which has
		// no retryDelay) and use the default 5-second backoff; the correct strict
		// equality skips it and still extracts 7s → first timer 8.
		expect(timerOf(sayMock.mock.calls[0])).toContain("<retry_timer>8</retry_timer>")
	})

	it("falls back to the default exponential backoff when no errorDetail matches RetryInfo", async () => {
		const { task, sayMock } = buildTask()
		const error: RetryApiError = Object.assign(new Error("rate limited"), {
			status: 429,
			errorDetails: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "quota" }],
		})

		await task["backoffAndAnnounce"](0, error)

		// No RetryInfo → ceil(baseDelay 5 * 2^0) = 5 → 5 countdown ticks + final say.
		// A condition-mutated-to-true predicate would match the ErrorInfo entry here;
		// it has no retryDelay, so this case alone cannot kill it, but it pins the
		// no-match behavior the equality/string mutants must invert to survive.
		const calls = sayMock.mock.calls
		expect(calls).toHaveLength(6)
		expect(calls[0][1]).toContain("<retry_timer>5</retry_timer>")
		expect(calls[5]).toEqual(["api_req_retry_delayed", "429\nrate limited\n", undefined, false])
	})

	it("ignores RetryInfo entirely for non-429 statuses", async () => {
		const { task, sayMock } = buildTask()
		const error: RetryApiError = Object.assign(new Error("server error"), {
			status: 500,
			errorDetails: [{ "@type": RETRY_INFO_TYPE, retryDelay: "7s" }],
		})

		await task["backoffAndAnnounce"](0, error)

		// 500 → the 429 gate never calls the predicate → default backoff of 5.
		expect(sayMock.mock.calls).toHaveLength(6)
		expect(timerOf(sayMock.mock.calls[0])).toContain("<retry_timer>5</retry_timer>")
	})
})
