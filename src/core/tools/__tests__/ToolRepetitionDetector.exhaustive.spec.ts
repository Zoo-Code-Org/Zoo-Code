// npx vitest run core/tools/__tests__/ToolRepetitionDetector.exhaustive.spec.ts
//
// Small exhaustive model check for ToolRepetitionDetector. It enumerates every
// sequence of events (same call, different call, mid-task limit change) up to
// a bounded length over a grid of limits, and checks each step of the real
// detector against the specification below.
//
// Specification, with n = number of identical calls immediately preceding the
// current one (0 for a fresh streak) and soft' = the effective soft limit:
//   1. Hard limit disabled (0) or unreachable (MAX_SAFE_INTEGER): never blocks
//      and never soft blocks.
//   2. With both tiers enabled, soft' < hard, so the soft block fires first.
//   3. hard_block iff hard enabled and n >= hard; otherwise soft_block iff
//      soft' > 0 and n >= soft'; otherwise allow.
//   4. A hard block or a different call starts a fresh streak (n = 0).
//   5. updateLimits keeps n but applies the new limits on the next call.
//   6. Escalation: once soft blocked, repeating the same call reaches a hard
//      block within (hard - n) more calls, so a soft block never repeats forever.

import type { ToolName } from "@roo-code/types"
import { normalizeToolRepetitionSoftLimit } from "@roo-code/types"

import type { ToolUse } from "../../../shared/tools"
import { ToolRepetitionDetector } from "../ToolRepetitionDetector"

vitest.mock("../../../i18n", () => ({ t: (key: string) => key }))

type Action = "allow" | "soft_block" | "hard_block"
type Limits = [soft: number, hard: number]
type Event = "same" | "different"

const UNLIMITED = Number.MAX_SAFE_INTEGER
const SOFT_VALUES = [0, 1, 2, 3, 5]
const HARD_VALUES = [0, 1, 2, 3, 4, UNLIMITED]
const SWITCH_SOFT_VALUES = [0, 1, 3]
const SWITCH_HARD_VALUES = [0, 2, UNLIMITED]

const pairs = (softs: number[], hards: number[]): Limits[] => softs.flatMap((s) => hards.map((h): Limits => [s, h]))
const LIMITS = pairs(SOFT_VALUES, HARD_VALUES)
const SWITCH_LIMITS = pairs(SWITCH_SOFT_VALUES, SWITCH_HARD_VALUES)

const isHardEnabled = (hard: number) => hard > 0 && hard < UNLIMITED

function sequences(maxLength: number): Event[][] {
	const result: Event[][] = [[]]
	let frontier: Event[][] = [[]]
	for (let length = 1; length <= maxLength; length++) {
		frontier = frontier.flatMap((seq) => [
			[...seq, "same" as const],
			[...seq, "different" as const],
		])
		result.push(...frontier)
	}
	return result
}

const toolA: ToolUse = { type: "tool_use", name: "read_file" as ToolName, params: { path: "a" }, partial: false }
const toolB: ToolUse = { type: "tool_use", name: "read_file" as ToolName, params: { path: "b" }, partial: false }

/**
 * Runs `events` against the real detector, optionally switching limits before
 * the event at `switchAt`, and checks every step against the specification.
 * The failure message (with a replayable trace) is only built on a violation,
 * because building it for every step would dominate the run time.
 */
function checkTrace(initial: Limits, events: Event[], switchAt?: number, switched?: Limits) {
	const detector = new ToolRepetitionDetector(...initial)
	let [soft, hard] = initial
	let current: ToolUse = toolA
	let previous: ToolUse | null = null
	let n = 0

	const fail = (step: number, property: string, detail: string): never => {
		throw new Error(
			`${property} violated at step ${step}: ${detail}\n` +
				`  initial limits=[${initial}] switch=${switchAt === undefined ? "none" : `before step ${switchAt} to [${switched}]`}\n` +
				`  events=${events.join(",")}`,
		)
	}

	for (let i = 0; i < events.length; i++) {
		if (switchAt === i && switched) {
			detector.updateLimits(...switched)
			;[soft, hard] = switched
		}

		if (events[i] === "different" && previous) {
			current = previous === toolA ? toolB : toolA
		}
		n = previous === current ? n + 1 : 0

		const hardEnabled = isHardEnabled(hard)
		const effectiveSoft = normalizeToolRepetitionSoftLimit(soft, hard)
		const expected: Action =
			hardEnabled && n >= hard ? "hard_block" : effectiveSoft > 0 && n >= effectiveSoft ? "soft_block" : "allow"
		const actual = detector.check({ ...current }).action

		// Property 1: no soft tier without a reachable hard stop.
		if (!hardEnabled && actual !== "allow") {
			fail(i, "Property 1 (no blocking without a reachable hard stop)", `n=${n} got ${actual}`)
		}
		// Property 2: an enabled soft tier always fires before the hard stop.
		if (hardEnabled && effectiveSoft >= hard) {
			fail(i, "Property 2 (soft fires before hard)", `soft'=${effectiveSoft} hard=${hard}`)
		}
		// Property 3 (and 4, 5 through the n/limit bookkeeping).
		if (actual !== expected) {
			fail(
				i,
				"Property 3 (action matches spec)",
				`n=${n} soft=${soft} hard=${hard} expected ${expected} got ${actual}`,
			)
		}

		if (actual === "hard_block") {
			previous = null // Property 4: a hard block starts a fresh streak.
			n = 0
		} else {
			previous = current
		}
	}
}

/**
 * Property 6: from any soft block, repeating the same call reaches a hard block
 * within the remaining budget, and only soft blocks happen in between.
 */
function checkEscalation(limits: Limits) {
	const [soft, hard] = limits
	const detector = new ToolRepetitionDetector(soft, hard)
	const effectiveSoft = normalizeToolRepetitionSoftLimit(soft, hard)
	const budget = isHardEnabled(hard) ? hard + 1 : 50
	const actions = Array.from({ length: budget }, () => detector.check({ ...toolA }).action)
	const context = `limits=[${limits}] actions=${actions.join(",")}`

	if (!isHardEnabled(hard)) {
		expect(new Set(actions), context).toEqual(new Set(["allow"]))
		return
	}

	// The streak ends with exactly one hard block on call hard + 1.
	expect(actions.at(-1), context).toBe("hard_block")
	expect(actions.slice(0, -1), context).not.toContain("hard_block")

	// Calls before the soft limit are allowed; calls from it until the hard stop
	// are soft blocked. No allow can appear after the first soft block.
	const expectedSoftBlocks = effectiveSoft > 0 ? hard - effectiveSoft : 0
	expect(actions.filter((a) => a === "soft_block").length, context).toBe(expectedSoftBlocks)
	const firstSoft = actions.indexOf("soft_block")
	if (firstSoft >= 0) {
		expect(actions.slice(firstSoft, -1), context).not.toContain("allow")
	}
}

describe("ToolRepetitionDetector exhaustive model check", () => {
	it("matches the specification for every event sequence up to length 8", () => {
		const allSequences = sequences(8)
		for (const limits of LIMITS) {
			for (const events of allSequences) {
				checkTrace(limits, events)
			}
		}
	})

	it("matches the specification when limits change mid-streak", () => {
		const allSequences = sequences(5)
		for (const initial of LIMITS) {
			for (const switched of SWITCH_LIMITS) {
				for (const events of allSequences) {
					for (let switchAt = 0; switchAt < events.length; switchAt++) {
						checkTrace(initial, events, switchAt, switched)
					}
				}
			}
		}
	})

	it("always escalates a soft block to a hard block, or never blocks when the hard stop is off", () => {
		for (const limits of LIMITS) {
			checkEscalation(limits)
		}
	})

	it("includes the boundary limits that hid the unlimited-hard-limit bug", () => {
		// Guard against someone trimming the grid and losing coverage of the
		// disabled, minimal and unreachable hard limits.
		expect(HARD_VALUES).toEqual(expect.arrayContaining([0, 1, UNLIMITED]))
		expect(SOFT_VALUES).toEqual(expect.arrayContaining([0, 1]))
		expect(SWITCH_HARD_VALUES).toEqual(expect.arrayContaining([0, UNLIMITED]))
	})
})
