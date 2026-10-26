import { TelemetryEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { initialRunState, nextRunState, type RunEvent, type RunState } from "../runState"
import {
	divergenceKey,
	findDivergences,
	isDivergenceCheckEnabled,
	KNOWN_RACES,
	reportDivergence,
	type KnownRace,
} from "../runStateDivergence"
import type { RunStateFields } from "../runStateShadow"

const idle: RunStateFields = {
	abort: false,
	abandoned: false,
	isInitialized: false,
	isStreaming: false,
	didFinishAbortingStream: false,
}

function drive(events: RunEvent[]): RunState {
	return events.reduce((state, event) => {
		const result = nextRunState(state, event)
		if (!("ok" in result)) {
			throw new Error(`expected ${event.tag} to be accepted`)
		}
		return result.ok
	}, initialRunState as RunState)
}

const fixtureRaces: KnownRace[] = [
	{
		id: "R-1",
		matches: (d) => d.mismatched.length === 1 && d.mismatched[0] === "didFinishAbortingStream",
	},
	{
		id: "R-3",
		matches: (d) =>
			d.kind === "rejection" &&
			d.event.tag === "askStarted" &&
			d.state.phase === "running" &&
			d.state.latches.abort,
	},
	{
		id: "R-4",
		matches: (d) => d.mismatched.length === 1 && d.mismatched[0] === "abortReason",
	},
]

const allFields: Array<keyof RunStateFields> = [
	"abort",
	"abandoned",
	"abortReason",
	"isInitialized",
	"isStreaming",
	"didFinishAbortingStream",
]

describe("findDivergences", () => {
	it("reports nothing when the fields and the kernel agree", () => {
		const state = drive([{ tag: "initialized" }])
		const divergences = findDivergences({
			event: { tag: "initialized" },
			state,
			fields: { ...idle, isInitialized: true },
			rejected: false,
			routed: allFields,
		})
		expect(divergences).toEqual([])
	})

	it("reports an untagged mismatch for a routed field", () => {
		const state = drive([{ tag: "initialized" }])
		const [divergence, ...rest] = findDivergences({
			event: { tag: "initialized" },
			state,
			fields: { ...idle, isInitialized: true, abort: true },
			rejected: false,
			routed: allFields,
		})
		expect(rest).toEqual([])
		expect(divergence).toMatchObject({ kind: "mismatch", mismatched: ["abort"] })
		expect(divergence.raceId).toBeUndefined()
	})

	it("compares the latch and phase fields by default and skips the stream fields", () => {
		const [divergence, ...rest] = findDivergences({
			event: { tag: "initialized" },
			state: initialRunState,
			fields: {
				abort: true,
				abandoned: true,
				abortReason: "user_cancelled",
				isInitialized: true,
				isStreaming: true,
				didFinishAbortingStream: true,
			},
			rejected: false,
		})
		expect(rest).toEqual([])
		expect(divergence).toMatchObject({ kind: "mismatch" })
		expect([...divergence.mismatched].sort()).toEqual(["abandoned", "abort", "abortReason", "isInitialized"])
	})

	it("ignores a field that is not routed", () => {
		const divergences = findDivergences({
			event: { tag: "initialized" },
			state: initialRunState,
			fields: { ...idle, abort: true },
			rejected: false,
			routed: ["isInitialized"],
		})
		expect(divergences).toEqual([])
	})

	it("reports an untagged rejection", () => {
		const [divergence] = findDivergences({
			event: { tag: "streamEnded" },
			state: initialRunState,
			fields: idle,
			rejected: true,
			routed: [],
		})
		expect(divergence).toMatchObject({ kind: "rejection", event: { tag: "streamEnded" } })
		expect(divergence.raceId).toBeUndefined()
	})

	it("tags a stale didFinishAbortingStream on a new stream as R-1", () => {
		const state = drive([{ tag: "initialized" }, { tag: "streamStarted" }])
		const [divergence] = findDivergences({
			event: { tag: "streamStarted" },
			state,
			fields: { ...idle, isInitialized: true, isStreaming: true, didFinishAbortingStream: true },
			rejected: false,
			routed: allFields,
			races: fixtureRaces,
		})
		expect(divergence).toMatchObject({ kind: "mismatch", raceId: "R-1" })
	})

	it("tags an ask rejected after abort as R-3", () => {
		const state = drive([{ tag: "initialized" }, { tag: "abortRequested", abandoned: false }])
		const [divergence] = findDivergences({
			event: { tag: "askStarted", ask: { tag: "approval", askTs: 1 } },
			state,
			fields: { ...idle, isInitialized: true, abort: true },
			rejected: true,
			routed: allFields,
			races: fixtureRaces,
		})
		expect(divergence).toMatchObject({ kind: "rejection", raceId: "R-3" })
	})

	it("does not tag an ask rejected before initialization as R-3", () => {
		const [divergence] = findDivergences({
			event: { tag: "askStarted", ask: { tag: "approval", askTs: 1 } },
			state: initialRunState,
			fields: idle,
			rejected: true,
			routed: allFields,
			races: fixtureRaces,
		})
		expect(divergence.raceId).toBeUndefined()
	})

	it("tags a reason overwritten after a cancel as R-4", () => {
		const state = drive([{ tag: "reasonSet", reason: "user_cancelled" }])
		const [divergence] = findDivergences({
			event: { tag: "reasonSet", reason: "streaming_failed" },
			state,
			fields: { ...idle, abortReason: "streaming_failed" },
			rejected: false,
			routed: allFields,
			races: fixtureRaces,
		})
		expect(divergence).toMatchObject({ kind: "mismatch", mismatched: ["abortReason"], raceId: "R-4" })
	})

	it("leaves a mismatch untagged when an unknown field mismatches beside a known race", () => {
		const state = drive([{ tag: "reasonSet", reason: "user_cancelled" }])
		const [divergence] = findDivergences({
			event: { tag: "reasonSet", reason: "streaming_failed" },
			state,
			fields: { ...idle, abortReason: "streaming_failed", abandoned: true },
			rejected: false,
			routed: allFields,
			races: fixtureRaces,
		})
		expect(divergence.mismatched).toEqual(["abandoned", "abortReason"])
		expect(divergence.raceId).toBeUndefined()
	})
})

describe("KNOWN_RACES", () => {
	it("is empty because the fixes for R-1, R-3, and R-4 have merged", () => {
		expect(KNOWN_RACES).toEqual([])
	})

	it("leaves a stale didFinishAbortingStream untagged by default", () => {
		const state = drive([{ tag: "initialized" }, { tag: "streamStarted" }])
		const [divergence] = findDivergences({
			event: { tag: "streamStarted" },
			state,
			fields: { ...idle, isInitialized: true, isStreaming: true, didFinishAbortingStream: true },
			rejected: false,
			routed: allFields,
		})
		expect(divergence).toMatchObject({ kind: "mismatch", mismatched: ["didFinishAbortingStream"] })
		expect(divergence.raceId).toBeUndefined()
	})
})

describe("divergenceKey", () => {
	it("is the same for the same kind, event tag, and fields", () => {
		const base = { kind: "mismatch" as const, event: { tag: "initialized" } as const, state: initialRunState }
		expect(divergenceKey({ ...base, fields: idle, mismatched: ["abort"] })).toBe(
			divergenceKey({ ...base, fields: { ...idle, abort: true }, mismatched: ["abort"] }),
		)
		expect(divergenceKey({ ...base, fields: idle, mismatched: ["abort"] })).not.toBe(
			divergenceKey({ ...base, fields: idle, mismatched: ["abandoned"] }),
		)
	})
})

describe("divergenceKey rejections", () => {
	it("differs when the kernel rejects the same event for a different reason", () => {
		const event: RunEvent = { tag: "askStarted", ask: { tag: "approval", askTs: 1 } }
		const rejection = (state: RunState) => ({
			kind: "rejection" as const,
			event,
			state,
			fields: idle,
			mismatched: [],
		})

		const beforeInit = rejection(initialRunState)
		const afterAbort = rejection(drive([{ tag: "initialized" }, { tag: "abortRequested", abandoned: false }]))

		expect(divergenceKey(beforeInit)).not.toBe(divergenceKey(afterAbort))
	})
})

describe("divergenceKey event payload", () => {
	const state = drive([{ tag: "initialized" }, { tag: "abortRequested", abandoned: false }])
	const rejectedAsk = (askTs: number) => ({
		kind: "rejection" as const,
		event: { tag: "askStarted", ask: { tag: "approval", askTs } } as const,
		state,
		fields: idle,
		mismatched: [],
	})

	it("differs for rejected events with different payloads", () => {
		expect(divergenceKey(rejectedAsk(1))).not.toBe(divergenceKey(rejectedAsk(2)))
	})

	it("is the same for a repeated identical event", () => {
		expect(divergenceKey(rejectedAsk(1))).toBe(divergenceKey(rejectedAsk(1)))
	})

	it("is the same when the event properties are built in a different order", () => {
		const reordered = {
			...rejectedAsk(1),
			event: { ask: { askTs: 1, tag: "approval" }, tag: "askStarted" } as const,
		}

		expect(divergenceKey(reordered)).toBe(divergenceKey(rejectedAsk(1)))
	})
})

describe("isDivergenceCheckEnabled", () => {
	it.each([
		["stable", 1, false],
		["stable", undefined, false],
		["prerelease", 1, true],
		["stable", 2, true],
		["stable", 3, true],
	])("channel %s, mode %s -> %s", (channel, mode, expected) => {
		expect(isDivergenceCheckEnabled(channel, mode)).toBe(expected)
	})
})

describe("reportDivergence", () => {
	let captureEvent: ReturnType<typeof vi.spyOn>
	let warn: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
		captureEvent = vi.spyOn(TelemetryService.instance, "captureEvent").mockImplementation(() => {})
		warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	const state = drive([{ tag: "initialized" }])
	const mismatch = {
		kind: "mismatch" as const,
		event: { tag: "initialized" } as const,
		state,
		fields: { ...idle, abort: true },
		mismatched: ["abort" as const],
	}

	it("logs once and counts an untagged divergence on the divergence metric", () => {
		reportDivergence("task-1", mismatch)

		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith("[RunState] divergence", {
			taskId: "task-1",
			kind: "mismatch",
			raceId: undefined,
			event: mismatch.event,
			state,
			fields: mismatch.fields,
			mismatched: ["abort"],
		})
		expect(captureEvent).toHaveBeenCalledTimes(1)
		expect(captureEvent).toHaveBeenCalledWith(TelemetryEventName.RUN_STATE_DIVERGENCE, {
			taskId: "task-1",
			kind: "mismatch",
			raceId: undefined,
			eventTag: "initialized",
			mismatched: ["abort"],
			phase: "running",
			streamTag: "none",
			abort: false,
		})
	})

	it("still logs when telemetry is not created", () => {
		vi.spyOn(TelemetryService, "hasInstance").mockReturnValue(false)

		reportDivergence("task-1", mismatch)

		expect(warn).toHaveBeenCalledTimes(1)
		expect(captureEvent).not.toHaveBeenCalled()
	})

	it("counts a tagged divergence on the known-race metric with its race ID", () => {
		reportDivergence("task-1", { ...mismatch, raceId: "R-3" })

		expect(captureEvent).toHaveBeenCalledTimes(1)
		expect(captureEvent).toHaveBeenCalledWith(
			TelemetryEventName.RUN_STATE_KNOWN_RACE,
			expect.objectContaining({ raceId: "R-3" }),
		)
	})
})
