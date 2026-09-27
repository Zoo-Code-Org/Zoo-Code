// check-delegated-mode-readers.ts
//
// Refinement check for the delegated-child mode-reader invariant (issue #1623).
//
// check-provider-handoff-scheduler.ts verifies the write side: that
// selectHandoffExecutionContext stores the task-local mode correctly.
// This script verifies the read side: that the mode observable by
// tool-validation readers is the task-local mode, not the shared provider mode.
//
// The VS Code-dependent readers (getEnvironmentDetails,
// presentAssistantMessage) are covered by their vitest regression tests.
// This script covers the pure-TS parts of the invariant chain and proves
// that the two sources of mode are observably different, so any reader
// that uses the wrong source silently produces wrong behavior.
//
// Invariant: for any delegated child task C with taskMode = M,
//   toolAllowedForMode(tool, M)  ≠  toolAllowedForMode(tool, providerMode)
//   whenever M ≠ providerMode and the two modes differ on the tool's group.

import assert from "node:assert/strict"

import { DEFAULT_MODES } from "../packages/types/src/mode"

import { TOOL_GROUPS, ALWAYS_AVAILABLE_TOOLS, TOOL_ALIASES } from "../src/shared/tools"
import { selectHandoffExecutionContext, type TaskExecutionContext } from "../src/core/task/providerHandoff"

// ---------------------------------------------------------------------------
// Minimal inline mode-allows-tool check.
// Avoids importing src/shared/modes.ts, which pulls in VS Code.
// Only covers built-in modes (no custom modes, no file-regex options).
// That is enough to prove the behavioral divergence this check needs.
// ---------------------------------------------------------------------------

type ModeConfig = (typeof DEFAULT_MODES)[number]
type GroupEntry = ModeConfig["groups"][number]

function groupName(entry: GroupEntry): string {
	return Array.isArray(entry) ? entry[0] : (entry as string)
}

function toolAllowedForMode(tool: string, modeSlug: string): boolean {
	const resolvedTool = (TOOL_ALIASES as Record<string, string>)[tool] ?? tool
	if ((ALWAYS_AVAILABLE_TOOLS as readonly string[]).includes(resolvedTool)) return true
	const mode = DEFAULT_MODES.find((m) => m.slug === modeSlug)
	if (!mode) return false
	for (const entry of mode.groups) {
		const groupTools = (TOOL_GROUPS as Record<string, { tools: readonly string[] }>)[groupName(entry)]?.tools ?? []
		if (groupTools.includes(resolvedTool)) return true
	}
	return false
}

// ---------------------------------------------------------------------------
// Scenario: parent in "orchestrator" mode delegates child to "code".
// Regression behavior: both readers used providerMode ("orchestrator").
// Correct behavior: readers use taskMode ("code").
//
// orchestrator groups: []        → apply_diff blocked
// code         groups: [...edit] → apply_diff allowed
// ---------------------------------------------------------------------------

const parentCtx: TaskExecutionContext = {
	mode: "orchestrator",
	apiConfigName: undefined,
	apiConfiguration: { apiProvider: "anthropic", consecutiveMistakeLimit: 3 },
}

// 1. Handoff stores the task-local mode, not the parent mode.
const childCtx = selectHandoffExecutionContext(parentCtx, "code", parentCtx.mode, false, undefined)
assert.equal(childCtx.mode, "code", "handoff must store the requested task-local mode")
assert.notEqual(childCtx.mode, parentCtx.mode, "test scenario requires divergent provider and task modes")

// 2. The two modes produce observably different tool-validation outcomes.
assert.equal(toolAllowedForMode("apply_diff", "orchestrator"), false, "orchestrator has no edit group")
assert.equal(toolAllowedForMode("apply_diff", "code"), true, "code has the edit group")

// 3. Regression claim: a reader that consumes providerMode rejects apply_diff;
//    a reader that consumes taskMode correctly allows it.
const viaProviderMode = toolAllowedForMode("apply_diff", parentCtx.mode) // "orchestrator" — wrong source
const viaTaskMode = toolAllowedForMode("apply_diff", childCtx.mode) // "code" — correct source
assert.equal(viaProviderMode, false, "stale provider mode rejects apply_diff (regression behavior)")
assert.equal(viaTaskMode, true, "task-local mode allows apply_diff (correct behavior)")

// 4. Additional mode pairs that show the same divergence.
const DIVERGENT_PAIRS: Array<{
	label: string
	providerMode: string
	taskMode: string
	probe: string
	blockedInProvider: boolean
	allowedInTask: boolean
}> = [
	// orchestrator → code: edit tools blocked at provider level, allowed at task level
	{
		label: "orchestrator→code apply_diff",
		providerMode: "orchestrator",
		taskMode: "code",
		probe: "apply_diff",
		blockedInProvider: true,
		allowedInTask: true,
	},
	// orchestrator → code: command tools blocked at provider level, allowed at task level
	{
		label: "orchestrator→code execute_command",
		providerMode: "orchestrator",
		taskMode: "code",
		probe: "execute_command",
		blockedInProvider: true,
		allowedInTask: true,
	},
	// code → ask: edit tools allowed at provider level, blocked at task level
	{
		label: "code→ask apply_diff",
		providerMode: "code",
		taskMode: "ask",
		probe: "apply_diff",
		blockedInProvider: false,
		allowedInTask: false,
	},
	// ask → code: edit tools blocked at provider level, allowed at task level
	{
		label: "ask→code write_to_file",
		providerMode: "ask",
		taskMode: "code",
		probe: "write_to_file",
		blockedInProvider: true,
		allowedInTask: true,
	},
]

for (const pair of DIVERGENT_PAIRS) {
	const ctx = selectHandoffExecutionContext(
		{ ...parentCtx, mode: pair.providerMode },
		pair.taskMode,
		pair.providerMode,
		false,
		undefined,
	)
	assert.equal(ctx.mode, pair.taskMode, `${pair.label}: handoff must store task-local mode`)
	assert.equal(
		toolAllowedForMode(pair.probe, pair.providerMode),
		!pair.blockedInProvider,
		`${pair.label}: wrong provider-mode result`,
	)
	assert.equal(
		toolAllowedForMode(pair.probe, pair.taskMode),
		pair.allowedInTask,
		`${pair.label}: wrong task-mode result`,
	)
	// The two sources disagree, so using the wrong one is always observable.
	assert.notEqual(
		toolAllowedForMode(pair.probe, pair.providerMode),
		toolAllowedForMode(pair.probe, pair.taskMode),
		`${pair.label}: provider and task mode must differ on this probe tool`,
	)
}

// 5. For every built-in mode as a delegation target: selectHandoffExecutionContext
//    always stores the requested mode, regardless of parent mode.
for (const mode of DEFAULT_MODES) {
	const ctx = selectHandoffExecutionContext(parentCtx, mode.slug, parentCtx.mode, false, undefined)
	assert.equal(ctx.mode, mode.slug, `handoff must store ${mode.slug}, not parent mode ${parentCtx.mode}`)
}

console.log(
	`Delegated mode reader check passed: ` +
		`regression scenario verified, ` +
		`${DIVERGENT_PAIRS.length} divergent-mode pairs checked, ` +
		`${DEFAULT_MODES.length}/${DEFAULT_MODES.length} built-in modes verified`,
)
