import { z } from "zod"

/**
 * Maximum number of pinned organization targets allowed at one time.
 */
export const MAX_PINNED_TARGETS = 3

/**
 * Error codes for task organization operations.
 *
 * Format: TASK_ORG/<DOMAIN>/<NNN>
 */
export type TaskOrganizationErrorCode =
	| "TASK_ORG/VALIDATION/001"
	| "TASK_ORG/CONFLICT/002"
	| "TASK_ORG/PIN_LIMIT/003"
	| "TASK_ORG/NOT_FOUND/004"
	| "TASK_ORG/PERSISTENCE/005"
	| "TASK_ORG/CORRUPT/006"
	| "TASK_ORG/FUTURE_SCHEMA/007"

/**
 * A canonical organization target for dragging, pinning, and folder membership.
 */
export const taskOrganizationTargetSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("task"),
		taskId: z.string(),
	}),
	z.object({
		kind: z.literal("autoGroup"),
		rootTaskId: z.string(),
	}),
	z.object({
		kind: z.literal("folder"),
		folderId: z.string(),
	}),
])

export type TaskOrganizationTargetV1 = z.infer<typeof taskOrganizationTargetSchema>

/**
 * A single pinned target and the time it was pinned.
 */
export const pinnedItemSchema = z.object({
	target: taskOrganizationTargetSchema,
	pinnedAt: z.number(),
})

export type PinnedItemV1 = z.infer<typeof pinnedItemSchema>

/**
 * A user-created manual folder containing canonical organization units.
 */
export const manualTaskFolderSchema = z.object({
	folderId: z.string(),
	name: z.string().min(1).max(80),
	taskIds: z.array(z.string()),
	createdAt: z.number(),
	updatedAt: z.number(),
})

export type ManualTaskFolderV1 = z.infer<typeof manualTaskFolderSchema>

/**
 * The persisted task organization aggregate for schema version 1.
 */
export const taskOrganizationStateSchema = z.object({
	schemaVersion: z.literal(1),
	revision: z.number().int().min(0),
	folders: z.array(manualTaskFolderSchema),
	pins: z.array(pinnedItemSchema).max(MAX_PINNED_TARGETS),
	updatedAt: z.number(),
})

export type TaskOrganizationStateV1 = z.infer<typeof taskOrganizationStateSchema>

/**
 * Idempotent mutation commands for the organization aggregate.
 */
export const taskOrganizationMutationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("createFolder"),
		folderId: z.string(),
		name: z.string(),
		source: taskOrganizationTargetSchema,
		destination: taskOrganizationTargetSchema,
	}),
	z.object({
		kind: z.literal("createFolderFromSelection"),
		folderId: z.string(),
		name: z.string(),
		targets: z.array(taskOrganizationTargetSchema).min(2),
	}),
	z.object({
		kind: z.literal("deleteFolders"),
		folderIds: z.array(z.string()).min(1),
	}),
	z.object({
		kind: z.literal("renameFolder"),
		folderId: z.string(),
		name: z.string(),
	}),
	z.object({
		kind: z.literal("deleteFolder"),
		folderId: z.string(),
	}),
	z.object({
		kind: z.literal("moveToFolder"),
		source: taskOrganizationTargetSchema,
		folderId: z.string(),
	}),
	z.object({
		kind: z.literal("removeFromFolder"),
		source: taskOrganizationTargetSchema,
		folderId: z.string(),
	}),
	z.object({
		kind: z.literal("setPinned"),
		target: taskOrganizationTargetSchema,
		pinned: z.boolean(),
	}),
])

export type TaskOrganizationMutationV1 = z.infer<typeof taskOrganizationMutationSchema>

/**
 * A webview -> host mutation request carrying the client request ID and the
 * last observed revision so the host can detect stale clients.
 */
export const taskOrganizationMutationRequestSchema = z.object({
	requestId: z.string(),
	baseRevision: z.number().int().min(0),
	mutation: taskOrganizationMutationSchema,
})

export type TaskOrganizationMutationRequestV1 = z.infer<typeof taskOrganizationMutationRequestSchema>

/**
 * Host -> webview acknowledgement or typed rejection for a mutation request.
 */
export const taskOrganizationMutationResultSchema = z.object({
	requestId: z.string(),
	success: z.boolean(),
	committedRevision: z.number().int().min(0),
	error: z
		.object({
			code: z.enum([
				"TASK_ORG/VALIDATION/001",
				"TASK_ORG/CONFLICT/002",
				"TASK_ORG/PIN_LIMIT/003",
				"TASK_ORG/NOT_FOUND/004",
				"TASK_ORG/PERSISTENCE/005",
				"TASK_ORG/CORRUPT/006",
				"TASK_ORG/FUTURE_SCHEMA/007",
			]),
			message: z.string(),
		})
		.optional(),
})

export type TaskOrganizationMutationResultV1 = z.infer<typeof taskOrganizationMutationResultSchema>

/**
 * Creates an empty, version-1 task organization state.
 */
export function createEmptyTaskOrganizationState(now: number = 0): TaskOrganizationStateV1 {
	return {
		schemaVersion: 1,
		revision: 0,
		folders: [],
		pins: [],
		updatedAt: now,
	}
}
