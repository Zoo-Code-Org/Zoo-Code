import { type ClineSayTool, type ModelInfo } from "@roo-code/types"

import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import type { ToolUse } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"

/**
 * DTE series 3/5: model-driven per-turn thinking effort.
 *
 * The model calls this tool to adjust its own thinking effort mid-task.
 * There is NO approval gate (non-destructive, clamped to the model
 * capability, instantly undoable); guardrails replace approval:
 * - always a one-line chat notification (success or refusal)
 * - escalation cap: max 3 upward changes per task
 * - oscillation detection: A -> B -> A ping-pong within a task (including a
 *   return to the task baseline) is refused
 * - hard clamp to the model capability array
 *
 * The tool is only exposed when the dynamicThinkingEffort experiment is on
 * and the model supports per-request effort (see filter-tools-for-mode.ts);
 * the checks below are defense in depth for stale or direct invocations.
 */

interface SetThinkingEffortParams {
	effort: string
	reason: string
}

/**
 * Canonical effort ordering used to detect upward changes. "disable" ranks
 * lowest: it is a UI/control value that can only appear as the
 * settings-derived baseline, never as a value this tool may set.
 */
export const EFFORT_RANK: Record<string, number> = {
	disable: 0,
	none: 1,
	minimal: 2,
	low: 3,
	medium: 4,
	high: 5,
	xhigh: 6,
	max: 7,
}

/** Effort levels this tool may set (disable excluded — see above). */
export const SETTABLE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

type SettableEffort = (typeof SETTABLE_EFFORTS)[number]

/** Max upward (escalating) changes per task before the tool refuses. */
export const MAX_UPWARD_CHANGES = 3

/** Per-task guardrail state (scoped per Task; see guardState WeakMap). */
interface EffortGuardState {
	upwardChanges: number
	/**
	 * Applied efforts, most recent last; seeded with the task's effective
	 * baseline (when defined) so returning to it counts as oscillation.
	 */
	history: string[]
}

function effortRank(level: string | undefined): number {
	return level === undefined ? EFFORT_RANK.disable : (EFFORT_RANK[level] ?? EFFORT_RANK.disable)
}

/**
 * Hard clamp to the model capability array: an in-array request passes
 * through unchanged; any other valid level is mapped to the nearest
 * supported level (ties resolved toward the lower level).
 *
 * Only recognized effort values (SETTABLE_EFFORTS plus "disable") count as
 * supported: capability arrays may carry provider-specific garbage, and the
 * nearest-level selection must never yield an unrecognized value that would
 * be applied as the runtime effort. Returns `undefined` when the array holds
 * no recognized value at all, in which case the caller must refuse the call.
 */
function clampToCapability(
	requested: SettableEffort,
	capability: ModelInfo["supportsReasoningEffort"],
): SettableEffort | "disable" | undefined {
	if (!Array.isArray(capability) || capability.length === 0) {
		return requested
	}
	const supported = capability.filter(
		(level): level is SettableEffort | "disable" =>
			(SETTABLE_EFFORTS as readonly string[]).includes(level) || level === "disable",
	)
	if (supported.length === 0) {
		return undefined
	}
	if (supported.includes(requested)) {
		return requested
	}
	const requestedRank = effortRank(requested)
	let best = supported[0]
	let bestDistance = Number.POSITIVE_INFINITY
	for (const level of supported) {
		const distance = Math.abs(effortRank(level) - requestedRank)
		// Ties resolve toward the lower effort level.
		if (distance < bestDistance || (distance === bestDistance && effortRank(level) < effortRank(best))) {
			best = level
			bestDistance = distance
		}
	}
	return best
}

export class SetThinkingEffortTool extends BaseTool<"set_thinking_effort"> {
	readonly name = "set_thinking_effort" as const

	/**
	 * Guardrail state is per-task. The tool instance is a module singleton,
	 * so state is keyed by Task instance in a WeakMap: each task starts
	 * fresh and state is garbage-collected with the task.
	 */
	private guardState = new WeakMap<Task, EffortGuardState>()

	private getGuardState(task: Task, baseline: string | undefined): EffortGuardState {
		let state = this.guardState.get(task)
		if (!state) {
			state = {
				upwardChanges: 0,
				// Seed the history with the task's effective baseline so that
				// returning from a changed value to the original baseline is
				// detected as oscillation (A -> B -> A) instead of re-applied.
				history: baseline === undefined ? [] : [baseline],
			}
			this.guardState.set(task, state)
		}
		return state
	}

	async execute(params: SetThinkingEffortParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { effort, reason } = params
		const { handleError, pushToolResult } = callbacks

		if (!effort) {
			task.consecutiveMistakeCount++
			task.recordToolError("set_thinking_effort")
			pushToolResult(await task.sayAndCreateMissingParamError("set_thinking_effort", "effort"))
			return
		}

		if (!reason) {
			task.consecutiveMistakeCount++
			task.recordToolError("set_thinking_effort")
			pushToolResult(await task.sayAndCreateMissingParamError("set_thinking_effort", "reason"))
			return
		}

		try {
			// Defense in depth: the tool is only exposed when the experiment is
			// on and the model supports per-request effort (task-start gate in
			// filter-tools-for-mode.ts), but stale or direct calls can reach here.
			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			if (!experiments.isEnabled(state?.experiments ?? {}, EXPERIMENT_IDS.DYNAMIC_THINKING_EFFORT)) {
				pushToolResult(
					formatResponse.toolError(
						"set_thinking_effort is unavailable: the dynamic thinking effort experiment is not enabled.",
					),
				)
				return
			}

			const capability = task.api.getModel().info.supportsReasoningEffort
			const hasCapability = capability === true || (Array.isArray(capability) && capability.length > 0)
			if (!hasCapability) {
				pushToolResult(
					formatResponse.toolError("The current model does not support per-request thinking effort."),
				)
				return
			}

			if (!(SETTABLE_EFFORTS as readonly string[]).includes(effort)) {
				task.consecutiveMistakeCount++
				task.recordToolError("set_thinking_effort")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						"Invalid thinking effort '" + effort + "'. Valid levels: " + SETTABLE_EFFORTS.join(", ") + ".",
					),
				)
				return
			}
			// Validated above: `effort` is one of the settable literal levels.
			const requested = effort as SettableEffort

			// Hard clamp to the model capability array.
			const clamped = clampToCapability(requested, capability)
			if (clamped === undefined) {
				// The capability array contains no recognizable effort level, so no valid
				// value can be applied; refuse the call (standard refusal path) instead of
				// applying an unrecognized value as the runtime effort.
				task.consecutiveMistakeCount++
				task.recordToolError("set_thinking_effort")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						"The current model does not advertise any usable thinking effort levels; keeping the current effort.",
					),
				)
				return
			}
			if (clamped === "disable") {
				// The clamp landed on "disable", which this tool cannot set (the
				// task-local API takes an effort level, not a UI off-switch).
				task.consecutiveMistakeCount++
				task.recordToolError("set_thinking_effort")
				task.didToolFailInCurrentTurn = true
				// Invariant: clampToCapability only returns "disable" when the
				// capability is a non-empty array containing "disable", so the
				// capability is a (non-empty) array here — single documented cast,
				// no double assertion.
				const supported = (capability as string[]).filter((l) => l !== "disable").join(", ")
				pushToolResult(
					formatResponse.toolError(
						"'" + effort + "' is not supported by the current model. Supported levels: " + supported + ".",
					),
				)
				return
			}

			const current = task.getRuntimeThinkingEffort().effort ?? task.apiConfiguration.reasoningEffort
			const guard = this.getGuardState(task, current)

			// No-op: already at the requested level — confirm without churn.
			if (clamped === current) {
				pushToolResult("Thinking effort is already '" + clamped + "'.")
				return
			}

			// Oscillation: A -> B -> A ping-pong within the task is refused.
			const last = guard.history[guard.history.length - 1]
			const secondLast = guard.history[guard.history.length - 2]
			if (secondLast !== undefined && secondLast === clamped && last !== clamped) {
				await task.say(
					"tool",
					JSON.stringify({ tool: "thinkingEffort", refusal: "oscillation" } satisfies ClineSayTool),
					undefined,
					false,
				)
				pushToolResult(
					formatResponse.toolError(
						"Thinking effort change refused: oscillation between '" +
							secondLast +
							"' and '" +
							last +
							"' detected. Keep the current effort.",
					),
				)
				return
			}

			const isUpward = effortRank(clamped) > effortRank(current)
			if (isUpward && guard.upwardChanges >= MAX_UPWARD_CHANGES) {
				await task.say(
					"tool",
					JSON.stringify({ tool: "thinkingEffort", refusal: "escalation_cap" } satisfies ClineSayTool),
					undefined,
					false,
				)
				pushToolResult(
					formatResponse.toolError(
						"Thinking effort change refused: the escalation limit of " +
							MAX_UPWARD_CHANGES +
							" upward changes per task has been reached.",
					),
				)
				return
			}

			// Apply (no approval gate) and notify with a single chat line.
			task.consecutiveMistakeCount = 0
			task.setRuntimeThinkingEffort(clamped, "model")
			if (isUpward) {
				guard.upwardChanges++
			}
			guard.history.push(clamped)

			const clampNote =
				clamped === effort
					? ""
					: " Requested '" + effort + "' was clamped to '" + clamped + "' (model capability)."
			await task.say(
				"tool",
				JSON.stringify({ tool: "thinkingEffort", effort: clamped, reason } satisfies ClineSayTool),
				undefined,
				false,
			)
			pushToolResult("Thinking effort is now '" + clamped + "'." + clampNote + " (Reason: " + reason + ")")
		} catch (error) {
			await handleError("setting thinking effort", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"set_thinking_effort">): Promise<void> {
		const effort: string | undefined = block.params.effort
		const reason: string | undefined = block.params.reason
		if (!effort && !reason) {
			return
		}
		const message = JSON.stringify({
			tool: "thinkingEffort",
			effort: effort ?? "",
			reason: reason ?? "",
		} satisfies ClineSayTool)
		// Partial say: updates the same one-line display as it streams in.
		await task.say("tool", message, undefined, true).catch(() => {})
	}
}

export const setThinkingEffortTool = new SetThinkingEffortTool()
