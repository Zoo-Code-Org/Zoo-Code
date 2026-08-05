import { z } from "zod"

import { ZOO_HOST_PROTOCOL_VERSION } from "./version.js"

export const approvalModeSchema = z.enum(["interactive", "safe", "auto"])
export type ApprovalMode = z.infer<typeof approvalModeSchema>

export const reasoningEffortSchema = z.enum([
	"disabled",
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
])

export const runOverridesSchema = z
	.object({
		provider: z.string().min(1).optional(),
		profile: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		mode: z.string().min(1).optional(),
		reasoningEffort: reasoningEffortSchema.optional(),
		approval: approvalModeSchema.optional(),
	})
	.strict()
	.refine(({ profile, provider }) => !(profile && provider), {
		message: "profile and provider are mutually exclusive",
	})

export type RunOverrides = z.infer<typeof runOverridesSchema>

const commandBaseSchema = z
	.object({
		v: z.literal(ZOO_HOST_PROTOCOL_VERSION),
		id: z.string().min(1),
	})
	.strict()

const taskStartCommandSchema = commandBaseSchema
	.extend({
		type: z.literal("task.start"),
		workspace: z.string().min(1),
		prompt: z.string().refine((prompt) => prompt.trim().length > 0, "Prompt cannot be blank"),
		overrides: runOverridesSchema.optional(),
	})
	.strict()

const taskResumeCommandSchema = commandBaseSchema
	.extend({
		type: z.literal("task.resume"),
		taskId: z.string().min(1),
		rootTaskId: z.string().min(1),
		overrides: runOverridesSchema.optional(),
	})
	.strict()

const taskInputCommandSchema = commandBaseSchema
	.extend({
		type: z.literal("task.input"),
		taskId: z.string().min(1),
		text: z.string().refine((text) => text.trim().length > 0, "Input cannot be blank").optional(),
		images: z.array(z.string().min(1)).min(1).optional(),
	})
	.strict()

const askRespondCommandSchema = commandBaseSchema
	.extend({
		type: z.literal("ask.respond"),
		taskId: z.string().min(1),
		askId: z.string().min(1),
		response: z.enum(["approve", "reject", "message"]),
		text: z.string().refine((text) => text.trim().length > 0, "Response cannot be blank").optional(),
	})
	.strict()

const taskCancelCommandSchema = commandBaseSchema
	.extend({
		type: z.literal("task.cancel"),
		rootTaskId: z.string().min(1),
		reason: z.enum(["user", "signal", "timeout"]),
	})
	.strict()

const historyListCommandSchema = commandBaseSchema
	.extend({ type: z.literal("history.list"), workspace: z.string().min(1) })
	.strict()
const hostSnapshotCommandSchema = commandBaseSchema.extend({ type: z.literal("host.snapshot") }).strict()
const hostShutdownCommandSchema = commandBaseSchema.extend({ type: z.literal("host.shutdown") }).strict()

const hostCommandDiscriminatedSchema = z.discriminatedUnion("type", [
	taskStartCommandSchema,
	taskResumeCommandSchema,
	taskInputCommandSchema,
	askRespondCommandSchema,
	taskCancelCommandSchema,
	historyListCommandSchema,
	hostSnapshotCommandSchema,
	hostShutdownCommandSchema,
])

export const hostCommandSchema = hostCommandDiscriminatedSchema.superRefine((command, context) => {
	if (command.type === "task.input" && command.text === undefined && command.images === undefined) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "task.input requires text or images" })
	}
	if (command.type === "ask.respond" && (command.response === "message") !== (command.text !== undefined)) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: "message responses require text and other responses forbid it",
		})
	}
})

export type HostCommand = z.infer<typeof hostCommandSchema>
