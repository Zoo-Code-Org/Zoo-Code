import { z } from "zod"

import { clineMessageSchema } from "@roo-code/types"

/**
 * Public wire types for Zoo account remote task control.
 * Paths live under /api/extension/remote/* and use the extension session token.
 */

export const zooRemoteCommandTypeSchema = z.enum([
	"message",
	"approve_ask",
	"deny_ask",
	"cancel_task",
	"resume_task",
	"start_task",
	"switch_mode",
	"answer_followup",
	"end_remote_session",
])

export type ZooRemoteCommandType = z.infer<typeof zooRemoteCommandTypeSchema>

export const zooRemoteCommandSchema = z.object({
	commandId: z.string().min(1),
	type: zooRemoteCommandTypeSchema,
	taskId: z.string().optional(),
	payload: z
		.object({
			text: z.string().optional(),
			images: z.array(z.string()).optional(),
			mode: z.string().optional(),
		})
		.optional(),
	timestamp: z.number().optional(),
})

export type ZooRemoteCommand = z.infer<typeof zooRemoteCommandSchema>

export const zooRemoteCommandsResponseSchema = z.object({
	commands: z.array(zooRemoteCommandSchema).default([]),
})

export type ZooRemoteCommandsResponse = z.infer<typeof zooRemoteCommandsResponseSchema>

export const zooRemoteEventTypeSchema = z.enum([
	"message",
	"task_interactive",
	"task_idle",
	"task_resumable",
	"task_completed",
	"task_aborted",
	"mode_switched",
])

export type ZooRemoteEventType = z.infer<typeof zooRemoteEventTypeSchema>

export const zooRemoteMessageActionSchema = z.enum(["created", "updated"])

export const zooRemoteEventSchema = z.object({
	type: zooRemoteEventTypeSchema,
	taskId: z.string().min(1),
	message: clineMessageSchema.optional(),
	action: zooRemoteMessageActionSchema.optional(),
	mode: z.string().optional(),
	seq: z.number().int().nonnegative().optional(),
	timestamp: z.number(),
})

export type ZooRemoteEvent = z.infer<typeof zooRemoteEventSchema>

export const zooRemotePresenceSchema = z.object({
	instanceId: z.string().min(1),
	apiProvider: z.string().min(1),
	workspacePath: z.string().optional(),
	taskId: z.string().optional(),
	online: z.boolean(),
	editorName: z.string().optional(),
	extensionVersion: z.string().optional(),
})

export type ZooRemotePresence = z.infer<typeof zooRemotePresenceSchema>

export const zooRemoteCommandAckSchema = z.object({
	commandId: z.string().min(1),
	status: z.enum(["acked", "failed"]),
	errorCode: z.string().optional(),
	message: z.string().optional(),
})

export type ZooRemoteCommandAck = z.infer<typeof zooRemoteCommandAckSchema>

export const zooRemoteSnapshotSchema = z.object({
	instanceId: z.string().min(1),
	taskId: z.string().min(1),
	messages: z.array(clineMessageSchema).max(500),
	mode: z.string().optional(),
})

export type ZooRemoteSnapshot = z.infer<typeof zooRemoteSnapshotSchema>
