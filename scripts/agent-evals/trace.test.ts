import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { RooCodeEventName, type TaskEvent } from "@roo-code/types"
import {
	TRACE_NOTES,
	createAccountant,
	digestProjection,
	eventTaskId,
	parseTaskEvent,
	stableStringify,
} from "./trace.ts"

let clock = 0
const fresh = () => createAccountant(() => ++clock)

const message = (ts: number, text: string | undefined): TaskEvent => ({
	eventName: RooCodeEventName.Message,
	payload: [{ taskId: "root", action: "created", message: { ts, type: "say", say: "api_req_started", text } }],
})

const usageEvent = (tokensIn: number, tokensOut: number, cacheWrites?: number): TaskEvent => ({
	eventName: RooCodeEventName.TaskTokenUsageUpdated,
	payload: [
		"root",
		{
			totalTokensIn: tokensIn,
			totalTokensOut: tokensOut,
			totalCost: 0,
			contextTokens: 11,
			...(cacheWrites === undefined ? {} : { totalCacheWrites: cacheWrites }),
		},
		{},
	],
})

describe("trace request accounting", () => {
	it("upserts one request row per message timestamp across created and updated events", () => {
		const accountant = fresh()
		accountant.observe(message(1, JSON.stringify({ apiProtocol: "openai" })))
		accountant.observe(
			message(
				1,
				JSON.stringify({
					apiProtocol: "openai",
					tokensIn: 10,
					tokensOut: 4,
					cacheWrites: 2,
					cacheReads: 3,
					cost: 0.5,
				}),
			),
		)
		accountant.observe(
			message(
				1,
				JSON.stringify({
					apiProtocol: "openai",
					tokensIn: 10,
					tokensOut: 4,
					cancelReason: "streaming_failed",
					streamingFailedMessage: "private provider error",
				}),
			),
		)
		const accounting = accountant.snapshot({
			accepted: true,
			sessionLost: false,
			bufferOverflow: false,
			malformedEvents: 0,
			foreignTaskEvents: 0,
		})
		assert.equal(accounting.requestCount, 1)
		const row = accounting.requests[0]
		assert.ok(row)
		assert.equal(row.messageCount, 3)
		assert.deepEqual(row.tokensIn, { available: true, value: 10 })
		assert.deepEqual(row.tokensOut, { available: true, value: 4 })
		assert.deepEqual(row.cacheWrites, { available: true, value: 2 })
		assert.deepEqual(row.cacheReads, { available: true, value: 3 })
		assert.deepEqual(row.cost, { available: true, value: 0.5 })
		assert.equal(row.cancelReason, "streaming_failed")
		assert.equal(row.streamingFailed, true)
		assert.ok(!JSON.stringify(accounting).includes("private provider error"))
	})

	it("marks requests without usage updates instead of filling zeros", () => {
		const accountant = fresh()
		accountant.observe(message(1, JSON.stringify({ tokensIn: 10, tokensOut: 2 })))
		accountant.observe(message(2, JSON.stringify({ apiProtocol: "openai" })))
		const accounting = accountant.snapshot({
			accepted: true,
			sessionLost: false,
			bufferOverflow: false,
			malformedEvents: 0,
			foreignTaskEvents: 0,
		})
		assert.equal(accounting.requestsMissingUsage, 1)
		assert.equal(accounting.completeness.status, "partial")
		assert.ok(accounting.completeness.reasons.includes("finalRequestMissingUsage"))
		const row = accounting.requests[1]
		assert.ok(row)
		assert.deepEqual(row.tokensIn, { available: false, reason: "notReported" })
		assert.deepEqual(row.tokensOut, { available: false, reason: "notReported" })
	})

	it("keeps only the latest cumulative snapshot and never sums snapshots", () => {
		const accountant = fresh()
		accountant.observe(usageEvent(10, 5))
		accountant.observe(usageEvent(25, 9))
		const accounting = accountant.snapshot({
			accepted: true,
			sessionLost: false,
			bufferOverflow: false,
			malformedEvents: 0,
			foreignTaskEvents: 0,
		})
		assert.equal(accounting.usage.snapshotsObserved, 2)
		assert.equal(accounting.usage.lastSnapshot?.tokensIn, 25)
		assert.equal(accounting.usage.lastSnapshot?.tokensOut, 9)
		assert.equal(accounting.usage.available, true)
		assert.ok(!("tokensInSum" in (accounting.usage as unknown as Record<string, unknown>)))
	})

	it("reports missing cache fields and zero tokens as caveated, not measured", () => {
		const accountant = fresh()
		accountant.observe(usageEvent(0, 0))
		const accounting = accountant.snapshot({
			accepted: true,
			sessionLost: false,
			bufferOverflow: false,
			malformedEvents: 0,
			foreignTaskEvents: 0,
		})
		assert.equal(accounting.usage.lastSnapshot?.tokensIn, 0)
		assert.deepEqual(accounting.usage.lastSnapshot?.cacheWrites, { available: false, reason: "notReported" })
		assert.ok(TRACE_NOTES.some((note) => note.includes("Zero token or cost values")))
	})

	it("counts tool failure events by name without storing error payloads", () => {
		const accountant = fresh()
		accountant.observe({
			eventName: RooCodeEventName.TaskToolFailed,
			payload: ["root", "execute_command", "private failure detail that must never persist"],
		})
		const accounting = accountant.snapshot({
			accepted: true,
			sessionLost: false,
			bufferOverflow: false,
			malformedEvents: 0,
			foreignTaskEvents: 0,
		})
		assert.equal(accounting.toolFailureEvents, 1)
		assert.deepEqual(accounting.toolFailuresByTool, { execute_command: 1 })
		assert.ok(!JSON.stringify(accounting).includes("private failure detail"))
	})

	it("counts retry marker messages separately from usage rows", () => {
		const accountant = fresh()
		accountant.observe({
			eventName: RooCodeEventName.Message,
			payload: [
				{
					taskId: "root",
					action: "created",
					message: { ts: 9, type: "say", say: "api_req_retried", text: "[retry marker]" },
				},
			],
		})
		const accounting = accountant.snapshot({
			accepted: true,
			sessionLost: false,
			bufferOverflow: false,
			malformedEvents: 0,
			foreignTaskEvents: 0,
		})
		assert.equal(accounting.apiReqRetriedMarkers, 1)
		assert.equal(accounting.requestCount, 0)
		assert.ok(TRACE_NOTES.some((note) => note.includes("not an HTTP retry count")))
	})

	it("reports no-usage completeness with a fixed reason", () => {
		const accounting = fresh().snapshot({
			accepted: true,
			sessionLost: false,
			bufferOverflow: false,
			malformedEvents: 0,
			foreignTaskEvents: 0,
		})
		assert.equal(accounting.usage.available, false)
		assert.equal(accounting.usage.unavailableReason, "noUsageEventsObserved")
		assert.ok(accounting.completeness.reasons.includes("noUsageEventsObserved"))
	})
})

describe("trace helpers", () => {
	it("documents the settings projection as the only configuration content", () => {
		assert.ok(TRACE_NOTES.some((note) => note.includes("nonsecret settings projection")))
	})

	it("documents the two completion signals and the observer stop reasons", () => {
		assert.ok(TRACE_NOTES.some((note) => note.includes("taskCompleted event")))
		assert.ok(TRACE_NOTES.some((note) => note.includes("completion_result")))
		assert.ok(TRACE_NOTES.some((note) => note.includes("adapterStopAfterCompletionMessage")))
	})

	it("digests projections stably regardless of key order", () => {
		assert.equal(digestProjection({ a: 1, b: { c: 2 } }), digestProjection({ b: { c: 2 }, a: 1 }))
		assert.notEqual(digestProjection({ a: 1 }), digestProjection({ a: 2 }))
		assert.equal(
			stableStringify({ b: 1, a: [2, { z: 3, y: 4 }] }),
			stableStringify({ a: [2, { y: 4, z: 3 }], b: 1 }),
		)
	})

	it("parses events defensively and reads task identities", () => {
		assert.equal(eventTaskId(parseTaskEvent(usageEvent(1, 1)) as TaskEvent), "root")
		assert.equal(
			eventTaskId(parseTaskEvent({ eventName: RooCodeEventName.TaskAborted, payload: ["root"] }) as TaskEvent),
			"root",
		)
		assert.equal(
			eventTaskId(parseTaskEvent({ eventName: RooCodeEventName.ModelsResponse, payload: [{}] }) as TaskEvent),
			undefined,
		)
		assert.equal(parseTaskEvent({ eventName: "bogus" }), undefined)
	})
})
