import { TelemetryEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import type { RunEvent, RunState } from "./runState"
import { projectRunState, readRunStateFields, type RunStateFields } from "./runStateShadow"

export type RaceId = `R-${number}`

export type Divergence = {
	kind: "mismatch" | "rejection"
	raceId?: RaceId
	event: RunEvent
	state: RunState
	fields: RunStateFields
	mismatched: Array<keyof RunStateFields>
}

export const ROUTED_FIELDS: ReadonlyArray<keyof RunStateFields> = ["abort", "abandoned", "abortReason", "isInitialized"]

export type KnownRace = { id: RaceId; matches: (divergence: Divergence) => boolean }

// Source: "Known code races" in task-lifecycle-target-architecture.md.
// Add an entry only for a race that still has an open fix issue. Delete it when that issue merges.
export const KNOWN_RACES: ReadonlyArray<KnownRace> = []

// Literals, not the vscode enum: specs that mock "vscode" without ExtensionMode would throw on the read.
const EXTENSION_MODE_DEVELOPMENT = 2
const EXTENSION_MODE_TEST = 3

export function isDivergenceCheckEnabled(releaseChannel: string, extensionMode: number | undefined): boolean {
	return (
		releaseChannel === "prerelease" ||
		extensionMode === EXTENSION_MODE_DEVELOPMENT ||
		extensionMode === EXTENSION_MODE_TEST
	)
}

const sortKeys = (_key: string, value: unknown): unknown =>
	value && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
		: value

export const divergenceKey = (d: Divergence): string =>
	`${d.kind}:${JSON.stringify(d.event, sortKeys)}:${d.mismatched.join(",")}:${d.state.phase}:${d.state.latches.abort}`

export function findDivergences(input: {
	event: RunEvent
	state: RunState
	fields: RunStateFields
	rejected: boolean
	routed?: ReadonlyArray<keyof RunStateFields>
	races?: ReadonlyArray<KnownRace>
}): Divergence[] {
	const { event, state, fields, rejected, routed = ROUTED_FIELDS, races = KNOWN_RACES } = input
	const expected = projectRunState(fields)
	const actual = readRunStateFields(state)
	const mismatched = routed.filter((field) => expected[field] !== actual[field])

	const candidates: Divergence[] = []
	if (rejected) {
		candidates.push({ kind: "rejection", event, state, fields, mismatched: [] })
	}
	if (mismatched.length > 0) {
		candidates.push({ kind: "mismatch", event, state, fields, mismatched })
	}
	return candidates.map((divergence) => {
		const race = races.find((known) => known.matches(divergence))
		return race ? { ...divergence, raceId: race.id } : divergence
	})
}

export function reportDivergence(taskId: string, divergence: Divergence): void {
	const { kind, raceId, event, state, fields, mismatched } = divergence
	console.warn("[RunState] divergence", { taskId, kind, raceId, event, state, fields, mismatched })

	if (TelemetryService.hasInstance()) {
		TelemetryService.instance.captureEvent(
			raceId ? TelemetryEventName.RUN_STATE_KNOWN_RACE : TelemetryEventName.RUN_STATE_DIVERGENCE,
			{
				taskId,
				kind,
				raceId,
				eventTag: event.tag,
				mismatched,
				phase: state.phase,
				streamTag: state.stream.tag,
				abort: state.latches.abort,
			},
		)
	}
}
