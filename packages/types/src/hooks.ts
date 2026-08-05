import { z } from "zod"

import { toolNames } from "./tool.js"

export const HOOK_TIMEOUT_MS = 10_000
export const HOOK_CAPTURE_MAX_BYTES = 64 * 1024
export const HOOK_MODEL_OUTPUT_MAX_BYTES = 16 * 1024
export const MAX_HOOK_DEFINITIONS = 50
export const MAX_HOOK_TOOL_MATCHERS = 32
export const MAX_HOOK_ARGV = 64

export const HOOK_CAPTURE_TRUNCATION_MARKER = "\n[hook output truncated at capture limit]\n"
export const HOOK_MODEL_TRUNCATION_MARKER = "\n[hook output omitted to fit model limit]\n"

export const hookPhases = ["sessionStart", "preToolUse"] as const
export const hookPhaseSchema = z.enum(hookPhases)
export type HookPhase = z.infer<typeof hookPhaseSchema>

const nulFreeString = (max: number, field: string) =>
	z
		.string()
		.max(max)
		.refine((value) => !value.includes("\0"), `${field} must not contain NUL characters`)

export const hookToolNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.refine((value) => !value.includes("\0"), "Tool name must not contain NUL characters")
export type HookToolName = z.infer<typeof hookToolNameSchema>
export const hookStaticToolNames = toolNames.filter((name) => name !== "custom_tool")

const hookDefinitionBaseSchema = z.object({
	id: z.string().min(1).max(64),
	name: z.string().trim().min(1).max(80),
	enabled: z.boolean(),
	executable: z
		.string()
		.trim()
		.min(1)
		.max(4096)
		.refine((value) => !value.includes("\0"), "Executable must not contain NUL characters"),
	argv: z.array(nulFreeString(4096, "Arguments")).max(MAX_HOOK_ARGV),
})

export const sessionStartHookDefinitionSchema = hookDefinitionBaseSchema.extend({
	phase: z.literal("sessionStart"),
	toolMatcher: z.never().optional(),
})

export const preToolUseHookDefinitionSchema = hookDefinitionBaseSchema.extend({
	phase: z.literal("preToolUse"),
	toolMatcher: z.array(hookToolNameSchema).min(1).max(MAX_HOOK_TOOL_MATCHERS),
})

export const hookDefinitionSchema = z.discriminatedUnion("phase", [
	sessionStartHookDefinitionSchema,
	preToolUseHookDefinitionSchema,
])
export type HookDefinition = z.infer<typeof hookDefinitionSchema>

export function findDuplicateHookDefinitionIds(definitions: readonly Pick<HookDefinition, "id">[]): string[] {
	const seen = new Set<string>()
	const duplicates = new Set<string>()

	for (const { id } of definitions) {
		if (seen.has(id)) {
			duplicates.add(id)
		}
		seen.add(id)
	}

	return [...duplicates]
}

export const hookDefinitionsSchema = z
	.array(hookDefinitionSchema)
	.max(MAX_HOOK_DEFINITIONS)
	.superRefine((definitions, context) => {
		for (const duplicateId of findDuplicateHookDefinitionIds(definitions)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Hook definition ID must be unique: ${duplicateId}`,
				path: [definitions.findIndex(({ id }) => id === duplicateId), "id"],
			})
		}
	})

export const DEFAULT_HOOK_DEFINITIONS: readonly HookDefinition[] = Object.freeze([])

export const hookInvocationSchema = z.discriminatedUnion("phase", [
	z.object({
		version: z.literal(1),
		hookRunId: z.string().min(1).max(128),
		phase: z.literal("sessionStart"),
		taskId: z.string().min(1).max(128),
		instanceId: z.string().min(1).max(128),
		workspacePath: z.string().min(1).max(4096),
	}),
	z.object({
		version: z.literal(1),
		hookRunId: z.string().min(1).max(128),
		phase: z.literal("preToolUse"),
		taskId: z.string().min(1).max(128),
		instanceId: z.string().min(1).max(128),
		workspacePath: z.string().min(1).max(4096),
		tool: z.object({ name: hookToolNameSchema }),
	}),
])
export type HookInvocation = z.infer<typeof hookInvocationSchema>

export const hookRunStatuses = ["succeeded", "blocked", "failed", "timedOut", "cancelled"] as const
export const hookRunStatusSchema = z.enum(hookRunStatuses)
export type HookRunStatus = z.infer<typeof hookRunStatusSchema>

export const hookRunResultSchema = z.object({
	hookRunId: z.string().min(1).max(128),
	hookId: z.string().min(1).max(64),
	phase: hookPhaseSchema,
	status: hookRunStatusSchema,
	exitCode: z.number().int().optional(),
	stdoutSummary: z.string().optional(),
	stderrSummary: z.string().optional(),
	truncated: z.boolean(),
	startedAt: z.number(),
	completedAt: z.number(),
})
export type HookRunResult = z.infer<typeof hookRunResultSchema>

export const hookMessageStatuses = [...hookRunStatuses, "running", "interrupted"] as const
export const hookMessageStatusSchema = z.enum(hookMessageStatuses)

export const hookMessageSchema = z.object({
	hookRunId: z.string().min(1).max(128),
	hookId: z.string().min(1).max(64),
	name: z.string().min(1).max(80),
	phase: hookPhaseSchema,
	status: hookMessageStatusSchema,
	matchedTool: hookToolNameSchema.optional(),
	outputSummary: z.string().optional(),
	errorSummary: z.string().optional(),
	truncated: z.boolean().optional(),
	startedAt: z.number(),
	completedAt: z.number().optional(),
})
export type HookMessage = z.infer<typeof hookMessageSchema>

export function hookMatches(definition: HookDefinition, phase: "sessionStart"): boolean
export function hookMatches(definition: HookDefinition, phase: "preToolUse", toolName: HookToolName): boolean
export function hookMatches(definition: HookDefinition, phase: HookPhase, toolName?: HookToolName): boolean {
	if (definition.phase !== phase) {
		return false
	}

	return (
		phase === "sessionStart" ||
		(definition.phase === "preToolUse" && toolName !== undefined && definition.toolMatcher.includes(toolName))
	)
}

export function getMatchingHooks(definitions: readonly HookDefinition[], phase: "sessionStart"): HookDefinition[]
export function getMatchingHooks(
	definitions: readonly HookDefinition[],
	phase: "preToolUse",
	toolName: HookToolName,
): HookDefinition[]
export function getMatchingHooks(
	definitions: readonly HookDefinition[],
	phase: HookPhase,
	toolName?: HookToolName,
): HookDefinition[] {
	return definitions.filter((definition) => definition.enabled && hookMatchesDefinition(definition, phase, toolName))
}

function hookMatchesDefinition(definition: HookDefinition, phase: HookPhase, toolName?: HookToolName): boolean {
	if (phase === "sessionStart") {
		return hookMatches(definition, phase)
	}

	return toolName !== undefined && hookMatches(definition, phase, toolName)
}

export type HookExitClassification =
	| { status: "succeeded"; decision: "continue" | "allow" }
	| { status: "blocked"; decision: "block" }
	| { status: "failed"; decision: "continue" | "block" }

export function classifyHookExit(phase: HookPhase, exitCode: number | null): HookExitClassification {
	if (phase === "sessionStart") {
		return exitCode === 0
			? { status: "succeeded", decision: "continue" }
			: { status: "failed", decision: "continue" }
	}

	if (exitCode === 0) {
		return { status: "succeeded", decision: "allow" }
	}

	return exitCode === 2 ? { status: "blocked", decision: "block" } : { status: "failed", decision: "block" }
}

export interface TruncatedHookOutput {
	output: string
	truncated: boolean
	omittedBytes: number
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })

function decodePrefix(bytes: Uint8Array, maxBytes: number): string {
	for (let end = Math.min(maxBytes, bytes.length); end >= 0; end--) {
		try {
			return textDecoder.decode(bytes.subarray(0, end))
		} catch {
			// Move to the previous UTF-8 boundary.
		}
	}
	return ""
}

function decodeSuffix(bytes: Uint8Array, maxBytes: number): string {
	for (let start = Math.max(0, bytes.length - maxBytes); start <= bytes.length; start++) {
		try {
			return textDecoder.decode(bytes.subarray(start))
		} catch {
			// Move to the next UTF-8 boundary.
		}
	}
	return ""
}

export function truncateHookCaptureOutput(output: string): TruncatedHookOutput {
	const bytes = textEncoder.encode(output)
	if (bytes.length <= HOOK_CAPTURE_MAX_BYTES) {
		return { output, truncated: false, omittedBytes: 0 }
	}

	const markerBytes = textEncoder.encode(HOOK_CAPTURE_TRUNCATION_MARKER).length
	const retained = decodePrefix(bytes, HOOK_CAPTURE_MAX_BYTES - markerBytes)
	const retainedBytes = textEncoder.encode(retained).length

	return {
		output: retained + HOOK_CAPTURE_TRUNCATION_MARKER,
		truncated: true,
		omittedBytes: bytes.length - retainedBytes,
	}
}

export function truncateHookModelOutput(output: string): TruncatedHookOutput {
	const bytes = textEncoder.encode(output)
	if (bytes.length <= HOOK_MODEL_OUTPUT_MAX_BYTES) {
		return { output, truncated: false, omittedBytes: 0 }
	}

	const markerBytes = textEncoder.encode(HOOK_MODEL_TRUNCATION_MARKER).length
	const retainedBudget = HOOK_MODEL_OUTPUT_MAX_BYTES - markerBytes
	const prefix = decodePrefix(bytes, Math.ceil(retainedBudget / 2))
	const suffix = decodeSuffix(bytes, Math.floor(retainedBudget / 2))
	const retainedBytes = textEncoder.encode(prefix).length + textEncoder.encode(suffix).length

	return {
		output: prefix + HOOK_MODEL_TRUNCATION_MARKER + suffix,
		truncated: true,
		omittedBytes: bytes.length - retainedBytes,
	}
}

export function sanitizeHookOutput(output: string): string {
	// ANSI control sequences are removed before other non-printable characters.
	// eslint-disable-next-line no-control-regex
	return output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replace(/[^\t\n\r\x20-\x7E\u0080-\uFFFF]/g, "")
}
