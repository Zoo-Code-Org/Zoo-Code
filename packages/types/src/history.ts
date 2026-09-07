import { z } from "zod"

import { todoItemSchema } from "./todo.js"

/**
 * HistoryItem
 */

export const pendingTaskActionSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("create_subtask"),
		actionId: z.string(),
		approvalText: z.string(),
		mode: z.string(),
		message: z.string(),
		todos: z.array(todoItemSchema),
	}),
	z.object({
		kind: z.literal("finish_subtask"),
		actionId: z.string(),
		approvalText: z.string(),
		parentTaskId: z.string(),
		result: z.string(),
	}),
])

export type PendingTaskAction = z.infer<typeof pendingTaskActionSchema>

/**
 * Durable child-side write-ahead marker for an in-flight provider handoff.
 *
 * The child's history record is written with this marker BEFORE the parent's
 * delegation record is committed, so a crash can never leave a parent
 * durably pointing at a child whose handoff identity was lost. The marker
 * carries the secret-free execution identity only (requested mode and the
 * explicit profile projection intent); the full API configuration is
 * deliberately NOT persisted — restart re-resolves it from the durable
 * profile store by name, matching normal resumed-task behavior.
 *
 * - `set`: the handoff carries a named profile identity.
 * - `preserve`: workspace profile pinning; the identity (if any) must not
 *   be rewritten by the handoff projection.
 * - `clear`: the handoff carries no profile identity (explicit clear).
 *
 * Absence of the field means the record is not a pending handoff. The
 * marker is stripped once the delegation commit is durable and the child's
 * in-memory context is authoritative; restart reconciliation replays the
 * strip for committed children and removes orphaned pre-commit children.
 */
export const pendingHandoffSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("set"),
		version: z.literal(1),
		mode: z.string(),
		profileName: z.string(),
	}),
	z.object({
		kind: z.literal("preserve"),
		version: z.literal(1),
		mode: z.string(),
		profileName: z.string().optional(),
	}),
	z.object({
		kind: z.literal("clear"),
		version: z.literal(1),
		mode: z.string(),
	}),
])

export type PendingHandoff = z.infer<typeof pendingHandoffSchema>

export const historyItemSchema = z.object({
	id: z.string(),
	rootTaskId: z.string().optional(),
	parentTaskId: z.string().optional(),
	number: z.number(),
	ts: z.number(),
	task: z.string(),
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
	totalCost: z.number(),
	size: z.number().optional(),
	workspace: z.string().optional(),
	mode: z.string().optional(),
	apiConfigName: z.string().optional(), // Provider profile name for sticky profile feature
	status: z.enum(["active", "completed", "delegated", "interrupted"]).optional(),
	delegatedToId: z.string().optional(), // Last child this parent delegated to
	childIds: z.array(z.string()).optional(), // All children spawned by this task
	awaitingChildId: z.string().optional(), // Child currently awaited (set when delegated)
	completedByChildId: z.string().optional(), // Child that completed and resumed this parent
	completionResultSummary: z.string().optional(), // Summary from completed child
	pendingAction: pendingTaskActionSchema.optional(),
	pendingHandoff: pendingHandoffSchema.optional(), // Durable child-side write-ahead marker for an in-flight delegation
})

export type HistoryItem = z.infer<typeof historyItemSchema>
