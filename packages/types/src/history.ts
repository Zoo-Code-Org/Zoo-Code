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
 * Token/cost totals for one provider+model within a task. A task can span
 * several (the user may switch profiles mid-task), so history keeps a list.
 */
export const usageByModelEntrySchema = z.object({
	apiProvider: z.string().optional(),
	modelId: z.string().optional(),
	requests: z.number(),
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheReads: z.number().optional(),
	cacheWrites: z.number().optional(),
	cost: z.number(),
})

export type UsageByModelEntry = z.infer<typeof usageByModelEntrySchema>

export const historyItemSchema = z.object({
	id: z.string(),
	rootTaskId: z.string().optional(),
	parentTaskId: z.string().optional(),
	number: z.number(),
	ts: z.number(),
	task: z.string(),
	title: z.string().optional(), // User-assigned display name; `task` keeps the original prompt
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
	totalCost: z.number(),
	/** Per provider+model breakdown, recorded as requests happen. Absent on tasks created before this was tracked. */
	usageByModel: z.array(usageByModelEntrySchema).optional(),
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
})

export type HistoryItem = z.infer<typeof historyItemSchema>
