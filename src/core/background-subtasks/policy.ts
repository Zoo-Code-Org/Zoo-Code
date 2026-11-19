/**
 * Task-local tool policy for background (read-only) child tasks, design
 * decision D3 of the sub-subtasks feature.
 *
 * Invariant: a background child's effective tool policy must never depend on,
 * or mutate, shared/global state. The child's block list and experiment
 * overrides are injected per task through `TaskOptions.backgroundToolPolicy`
 * and folded into the per-request policy snapshot at capture time, so the
 * prompt layer and the execution-time validator always block exactly the same
 * tool set while every other task keeps reading the ambient provider state.
 */
import type { ToolName } from "@roo-code/types"

/**
 * Tool names a background child can never call. `parallel_subtasks` is a
 * registered `ToolName` (Phase 3), so the alias is plain `ToolName`.
 */
export type BackgroundBlockedToolName = ToolName

/**
 * The read-only child block list.
 *
 * Depth-1 fan-out is enforced structurally by `parallel_subtasks` being in
 * this list: even after Phase 3 registers the tool, a child can never spawn
 * its own children.
 *
 * MCP is blocked by naming both `use_mcp_tool` and `access_mcp_resource`.
 * Both the wrapper tool and the dynamic `mcp_*` native calls validate under
 * the canonical `use_mcp_tool` name (see presentAssistantMessage), so one
 * entry covers both paths.
 *
 * Custom tools are deliberately NOT listed here: a custom tool validates under
 * its own registered name, so a `custom_tool` entry would never key-match.
 * The real protection is `BACKGROUND_CHILD_EXPERIMENTS.customTools = false`,
 * which closes the custom-tool path at both the prompt layer and
 * `validateToolUse` (see the pinning test in policy.spec.ts).
 */
export const BACKGROUND_CHILD_DISABLED_TOOLS: readonly BackgroundBlockedToolName[] = [
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"generate_image",
	"execute_command",
	"read_command_output",
	"run_slash_command",
	"skill",
	"switch_mode",
	"new_task",
	"parallel_subtasks",
	"ask_followup_question",
	"use_mcp_tool",
	"access_mcp_resource",
]

/**
 * Experiment overrides injected into a background child's policy snapshot.
 * `customTools: false` closes the experiment-gated custom-tool path at both
 * the prompt layer and `validateToolUse`, which read the same snapshot.
 */
export const BACKGROUND_CHILD_EXPERIMENTS: Record<string, boolean> = { customTools: false }

/**
 * Union a background child's task-local policy with the ambient provider
 * state, without mutating either input.
 *
 * The union direction is deliberate: a background child must be at least as
 * restricted as the user's global policy, never less. `disabledTools` entries
 * come state-first, then policy entries, de-duplicated by first occurrence;
 * `experiments` merge with the policy entries winning on conflict.
 *
 * @returns `disabledTools: []` and `experiments: undefined` when both inputs
 *   are absent or empty.
 */
export function mergeBackgroundToolPolicy(
	policy: { disabledTools?: readonly string[]; experiments?: Record<string, boolean> } | undefined,
	state: { disabledTools?: string[]; experiments?: Record<string, boolean> } | undefined,
): { disabledTools: string[]; experiments: Record<string, boolean> | undefined } {
	const disabledTools: string[] = []
	const seen = new Set<string>()
	for (const entry of state?.disabledTools ?? []) {
		if (!seen.has(entry)) {
			seen.add(entry)
			disabledTools.push(entry)
		}
	}
	for (const entry of policy?.disabledTools ?? []) {
		if (!seen.has(entry)) {
			seen.add(entry)
			disabledTools.push(entry)
		}
	}
	const experiments =
		state?.experiments === undefined && policy?.experiments === undefined
			? undefined
			: { ...state?.experiments, ...policy?.experiments }
	return { disabledTools, experiments }
}
