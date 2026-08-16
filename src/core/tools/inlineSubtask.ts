import type { TodoItem } from "@roo-code/types"

/**
 * Inputs for the auto-flatten inline decision.
 *
 * The decision is a pure function so it can be unit-tested without a live Task or
 * vscode host. `childDepth` is the depth a child Task would have if opened as a real
 * task (`parent.depth + 1`).
 */
export interface InlineFlattenInput {
	/** Depth the subtask would occupy if opened as a real child Task. */
	childDepth: number
	/** Configured maximum nesting depth (root = 0). `0` disables delegation entirely. */
	maxNestingDepth: number
	/** When true, an over-limit subtask runs inline instead of being rejected. */
	autoFlattenOnLimit: boolean
	/** True when this task is already executing an inline subtask phase. */
	inlineActive: boolean
	/** The subtask instruction (used to build the flatten directive). */
	message: string
	/** Parsed todos for the subtask (empty when none were provided). */
	todos: TodoItem[]
}

export type InlineFlattenDecision =
	| { action: "reject-nested"; message: string }
	| { action: "flatten"; directive: string }
	| { action: "reject-limit"; message: string }
	| { action: "delegate" }

/**
 * Decide how a `new_task` call should be handled given the current nesting depth and
 * settings. Pure — no side effects, no Task/vscode access.
 *
 * Precedence:
 * 1. A nested `new_task` while an inline phase is already active is rejected (P1 forbids
 *    recursion into a second inline subtask).
 * 2. Within the limit → normal delegation flow (`delegate`).
 * 3. Over the limit + `autoFlattenOnLimit` → flatten inline (`flatten`).
 * 4. Over the limit + `!autoFlattenOnLimit` → reject so work continues directly.
 */
export function decideInlineFlatten(input: InlineFlattenInput): InlineFlattenDecision {
	const { childDepth, maxNestingDepth, autoFlattenOnLimit, inlineActive, message, todos } = input

	if (inlineActive) {
		return {
			action: "reject-nested",
			message:
				"Cannot start a nested subtask while an inline subtask is already in progress. " +
				"Complete the current inline subtask with attempt_completion first.",
		}
	}

	const overLimit = childDepth > maxNestingDepth
	if (!overLimit) {
		return { action: "delegate" }
	}

	if (autoFlattenOnLimit) {
		return { action: "flatten", directive: buildInlineDirective(message, todos, maxNestingDepth) }
	}

	return {
		action: "reject-limit",
		message:
			`Nesting limit ${maxNestingDepth} reached and auto-flatten is disabled. ` +
			"Continue working directly in the current conversation instead of delegating.",
	}
}

/** Build the inline directive that doubles as the subtask prompt (zero synthetic messages). */
export function buildInlineDirective(message: string, todos: TodoItem[], maxNestingDepth: number): string {
	const todoText = todos.length > 0 ? `\nTodos:\n${todos.map((t) => `- [ ] ${t.content}`).join("\n")}` : ""
	return (
		`[auto-flattened: nesting limit ${maxNestingDepth} reached — executing inline]\n` +
		"You are now executing this subtask INLINE in the current conversation.\n" +
		`Subtask instruction: ${message}` +
		todoText +
		"\nExecute it with your available tools. When done, call attempt_completion " +
		"with a summary of what you did."
	)
}
