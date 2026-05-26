import { z } from "zod"

import { type Keys } from "./type-fu.js"
import {
	type ProviderSettings,
	PROVIDER_SETTINGS_KEYS,
	providerSettingsEntrySchema,
	providerSettingsSchema,
} from "./provider-settings.js"
import { historyItemSchema } from "./history.js"
import { codebaseIndexModelsSchema, codebaseIndexConfigSchema } from "./codebase-index.js"
import { experimentsSchema } from "./experiment.js"
import { telemetrySettingsSchema } from "./telemetry.js"
import { modeConfigSchema } from "./mode.js"
import { customModePromptsSchema, customSupportPromptsSchema } from "./mode.js"
import { toolNamesSchema } from "./tool.js"
import { languagesSchema } from "./vscode.js"

/**
 * Default delay in milliseconds after writes to allow diagnostics to detect potential problems.
 * This delay is particularly important for Go and other languages where tools like goimports
 * need time to automatically clean up unused imports.
 */
export const DEFAULT_WRITE_DELAY_MS = 1000

/** Schema for optional Git context included with generated commit message prompts. */
export const commitMessageGitContextSchema = z.object({
	diffContextLines: z.number().int().min(0).max(20).optional(),
	includeDiffStats: z.boolean().optional(),
	includeCurrentBranch: z.boolean().optional(),
	includeRecentCommits: z.boolean().optional(),
	recentCommitCount: z.number().int().min(1).max(20).optional(),
	includeRecentCommitBodies: z.boolean().optional(),
	includeRecentCommitStats: z.boolean().optional(),
	includeRecentCommitDiffs: z.boolean().optional(),
	recentCommitDiffCount: z.number().int().min(1).max(5).optional(),
})

export type CommitMessageGitContextSettings = z.infer<typeof commitMessageGitContextSchema>

/** Default Git context options for commit message generation. */
export const defaultCommitMessageGitContextSettings: Required<CommitMessageGitContextSettings> = {
	diffContextLines: 3,
	includeDiffStats: true,
	includeCurrentBranch: true,
	includeRecentCommits: true,
	recentCommitCount: 5,
	includeRecentCommitBodies: false,
	includeRecentCommitStats: false,
	includeRecentCommitDiffs: false,
	recentCommitDiffCount: 1,
}

/** Default attribution template appended to generated commit messages when enabled. */
export const DEFAULT_COMMIT_MESSAGE_ATTRIBUTION_TEMPLATE = "Assisted-by: ${agentName}:${providerModel} [${toolName}]"

/** Schema for the optional attribution footer appended to generated commit messages. */
export const commitMessageAttributionSchema = z.object({
	enabled: z.boolean().optional(),
	template: z.string().optional(),
})

export type CommitMessageAttributionSettings = z.infer<typeof commitMessageAttributionSchema>

/** Default attribution settings for commit message generation. */
export const defaultCommitMessageAttributionSettings: Required<CommitMessageAttributionSettings> = {
	enabled: false,
	template: DEFAULT_COMMIT_MESSAGE_ATTRIBUTION_TEMPLATE,
}

/** Maximum number of named commit-message profiles users can store. */
export const MAX_COMMIT_MESSAGE_PROFILES = 5

/** Stable id used by the synthesized default commit-message profile. */
export const DEFAULT_COMMIT_MESSAGE_PROFILE_ID = "default"

/** Schema for one named commit-message generation profile. */
export const commitMessageProfileSchema = z.object({
	id: z.string().optional(),
	name: z.string().optional(),
	prompt: z.string().optional(),
	apiConfigId: z.string().optional(),
	gitContext: commitMessageGitContextSchema.optional(),
	attribution: commitMessageAttributionSchema.optional(),
})

/** Schema for persisted commit-message profile settings. */
export const commitMessageProfilesSchema = z.object({
	activeProfileId: z.string().optional(),
	profiles: z.array(commitMessageProfileSchema).max(MAX_COMMIT_MESSAGE_PROFILES).optional(),
})

export type CommitMessageProfileSettings = z.infer<typeof commitMessageProfileSchema>
export type CommitMessageProfilesSettings = z.infer<typeof commitMessageProfilesSchema>

/** Fully-normalized commit-message profile used by runtime code and UI controls. */
export type NormalizedCommitMessageProfile = Omit<
	CommitMessageProfileSettings,
	"id" | "name" | "gitContext" | "attribution"
> & {
	id: string
	name: string
	gitContext: Required<CommitMessageGitContextSettings>
	attribution: Required<CommitMessageAttributionSettings>
}

export interface NormalizedCommitMessageProfiles {
	/** Id of the profile currently selected for generation. */
	activeProfileId: string
	/** Normalized profiles available for generation. */
	profiles: NormalizedCommitMessageProfile[]
}

/** Legacy single-profile settings used when named profiles are not stored yet. */
export interface CommitMessageProfileFallbackSettings {
	/** Optional custom prompt from the legacy support prompt setting. */
	prompt?: string
	/** Optional API configuration id from the legacy single-profile setting. */
	apiConfigId?: string
	/** Optional Git context settings from the legacy single-profile setting. */
	gitContext?: CommitMessageGitContextSettings
	/** Optional attribution settings from the legacy single-profile setting. */
	attribution?: CommitMessageAttributionSettings
}

/** Normalizes Git context settings and clamps numeric options to supported bounds. */
export function normalizeCommitMessageGitContextSettings(
	settings?: CommitMessageGitContextSettings,
): Required<CommitMessageGitContextSettings> {
	return {
		...defaultCommitMessageGitContextSettings,
		...settings,
		diffContextLines: clampNumberSetting(
			settings?.diffContextLines,
			0,
			20,
			defaultCommitMessageGitContextSettings.diffContextLines,
		),
		recentCommitCount: clampNumberSetting(
			settings?.recentCommitCount,
			1,
			20,
			defaultCommitMessageGitContextSettings.recentCommitCount,
		),
		recentCommitDiffCount: clampNumberSetting(
			settings?.recentCommitDiffCount,
			1,
			5,
			defaultCommitMessageGitContextSettings.recentCommitDiffCount,
		),
	}
}

/** Normalizes attribution settings and restores the default template when needed. */
export function normalizeCommitMessageAttributionSettings(
	settings?: CommitMessageAttributionSettings,
): Required<CommitMessageAttributionSettings> {
	return {
		...defaultCommitMessageAttributionSettings,
		...settings,
		template: normalizeOptionalString(settings?.template) ?? defaultCommitMessageAttributionSettings.template,
	}
}

/** Normalizes persisted profiles or creates a default profile from fallback settings. */
export function normalizeCommitMessageProfiles(
	settings?: CommitMessageProfilesSettings,
	fallback: CommitMessageProfileFallbackSettings = {},
): NormalizedCommitMessageProfiles {
	const sourceProfiles = settings?.profiles?.length
		? settings.profiles.slice(0, MAX_COMMIT_MESSAGE_PROFILES)
		: [
				{
					id: DEFAULT_COMMIT_MESSAGE_PROFILE_ID,
					name: "Default",
					prompt: fallback.prompt,
					apiConfigId: fallback.apiConfigId,
					gitContext: fallback.gitContext,
					attribution: fallback.attribution,
				},
			]

	const profiles: NormalizedCommitMessageProfile[] = sourceProfiles.map((profile, index) => ({
		id: normalizeProfileId(profile.id, index),
		name: normalizeProfileName(profile.name, index),
		prompt: profile.prompt,
		apiConfigId: normalizeOptionalString(profile.apiConfigId),
		gitContext: normalizeCommitMessageGitContextSettings(profile.gitContext),
		attribution: normalizeCommitMessageAttributionSettings(profile.attribution),
	}))
	const firstProfile = profiles[0]!

	const activeProfileId = profiles.some((profile) => profile.id === settings?.activeProfileId)
		? settings!.activeProfileId!
		: firstProfile.id

	return {
		activeProfileId,
		profiles,
	}
}

/** Returns the active normalized commit-message profile. */
export function getActiveCommitMessageProfile(
	settings?: CommitMessageProfilesSettings,
	fallback?: CommitMessageProfileFallbackSettings,
): NormalizedCommitMessageProfile {
	const normalized = normalizeCommitMessageProfiles(settings, fallback)
	return normalized.profiles.find((profile) => profile.id === normalized.activeProfileId) ?? normalized.profiles[0]!
}

/** Creates a locally unique id for a new commit-message profile. */
export function createCommitMessageProfileId(): string {
	return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Creates the next available display name for a new commit-message profile. */
export function createCommitMessageProfileName(profiles: Array<{ name?: string }>): string {
	for (let index = profiles.length + 1; index <= MAX_COMMIT_MESSAGE_PROFILES + 1; index++) {
		const candidate = `Profile ${index}`
		if (!profiles.some((profile) => profile.name === candidate)) {
			return candidate
		}
	}

	return `Profile ${profiles.length + 1}`
}

function normalizeProfileId(id: string | undefined, index: number): string {
	const normalized = normalizeOptionalString(id)
	if (normalized) {
		return normalized
	}

	return index === 0 ? DEFAULT_COMMIT_MESSAGE_PROFILE_ID : `profile-${index + 1}`
}

function normalizeProfileName(name: string | undefined, index: number): string {
	const normalized = normalizeOptionalString(name)
	return normalized || (index === 0 ? "Default" : `Profile ${index + 1}`)
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined
	}

	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

function clampNumberSetting(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback
	}

	return Math.min(Math.max(Math.trunc(value), min), max)
}

/**
 * Terminal output preview size options for persisted command output.
 *
 * Controls how much command output is kept in memory as a "preview" before
 * the LLM decides to retrieve more via `read_command_output`. Larger previews
 * mean more immediate context but consume more of the context window.
 *
 * - `small`: 5KB preview - Best for long-running commands with verbose output
 * - `medium`: 10KB preview - Balanced default for most use cases
 * - `large`: 20KB preview - Best when commands produce critical info early
 *
 * @see OutputInterceptor - Uses this setting to determine when to spill to disk
 * @see PersistedCommandOutput - Contains the resulting preview and artifact reference
 */
export type TerminalOutputPreviewSize = "small" | "medium" | "large"

/**
 * Byte limits for each terminal output preview size.
 *
 * Maps preview size names to their corresponding byte thresholds.
 * When command output exceeds these thresholds, the excess is persisted
 * to disk and made available via the `read_command_output` tool.
 */
export const TERMINAL_PREVIEW_BYTES: Record<TerminalOutputPreviewSize, number> = {
	small: 5 * 1024, // 5KB
	medium: 10 * 1024, // 10KB
	large: 20 * 1024, // 20KB
}

/**
 * Default terminal output preview size.
 * The "medium" (10KB) setting provides a good balance between immediate
 * visibility and context window conservation for most use cases.
 */
export const DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE: TerminalOutputPreviewSize = "medium"

/**
 * Minimum checkpoint timeout in seconds.
 */
export const MIN_CHECKPOINT_TIMEOUT_SECONDS = 10

/**
 * Maximum checkpoint timeout in seconds.
 */
export const MAX_CHECKPOINT_TIMEOUT_SECONDS = 60

/**
 * Default checkpoint timeout in seconds.
 */
export const DEFAULT_CHECKPOINT_TIMEOUT_SECONDS = 15

/**
 * GlobalSettings
 */

export const globalSettingsSchema = z.object({
	currentApiConfigName: z.string().optional(),
	listApiConfigMeta: z.array(providerSettingsEntrySchema).optional(),
	pinnedApiConfigs: z.record(z.string(), z.boolean()).optional(),

	lastShownAnnouncementId: z.string().optional(),
	customInstructions: z.string().optional(),
	taskHistory: z.array(historyItemSchema).optional(),
	dismissedUpsells: z.array(z.string()).optional(),

	// Image generation settings (experimental) - flattened for simplicity
	imageGenerationProvider: z.enum(["openrouter"]).optional(),
	openRouterImageApiKey: z.string().optional(),
	openRouterImageGenerationSelectedModel: z.string().optional(),

	customCondensingPrompt: z.string().optional(),

	autoApprovalEnabled: z.boolean().optional(),
	alwaysAllowReadOnly: z.boolean().optional(),
	alwaysAllowReadOnlyOutsideWorkspace: z.boolean().optional(),
	alwaysAllowWrite: z.boolean().optional(),
	alwaysAllowWriteOutsideWorkspace: z.boolean().optional(),
	alwaysAllowWriteProtected: z.boolean().optional(),
	writeDelayMs: z.number().min(0).optional(),
	requestDelaySeconds: z.number().optional(),
	alwaysAllowMcp: z.boolean().optional(),
	alwaysAllowModeSwitch: z.boolean().optional(),
	alwaysAllowSubtasks: z.boolean().optional(),
	alwaysAllowExecute: z.boolean().optional(),
	alwaysAllowFollowupQuestions: z.boolean().optional(),
	followupAutoApproveTimeoutMs: z.number().optional(),
	allowedCommands: z.array(z.string()).optional(),
	deniedCommands: z.array(z.string()).optional(),
	commandExecutionTimeout: z.number().optional(),
	commandTimeoutAllowlist: z.array(z.string()).optional(),
	preventCompletionWithOpenTodos: z.boolean().optional(),
	allowedMaxRequests: z.number().nullish(),
	allowedMaxCost: z.number().nullish(),
	autoCondenseContext: z.boolean().optional(),
	autoCondenseContextPercent: z.number().optional(),

	/**
	 * Whether to include current time in the environment details
	 * @default true
	 */
	includeCurrentTime: z.boolean().optional(),
	/**
	 * Whether to include current cost in the environment details
	 * @default true
	 */
	includeCurrentCost: z.boolean().optional(),
	/**
	 * Maximum number of git status file entries to include in the environment details.
	 * Set to 0 to disable git status. The header (branch, commits) is always included when > 0.
	 * @default 0
	 */
	maxGitStatusFiles: z.number().optional(),

	/**
	 * Whether to include diagnostic messages (errors, warnings) in tool outputs
	 * @default true
	 */
	includeDiagnosticMessages: z.boolean().optional(),
	/**
	 * Maximum number of diagnostic messages to include in tool outputs
	 * @default 50
	 */
	maxDiagnosticMessages: z.number().optional(),

	enableCheckpoints: z.boolean().optional(),
	checkpointTimeout: z
		.number()
		.int()
		.min(MIN_CHECKPOINT_TIMEOUT_SECONDS)
		.max(MAX_CHECKPOINT_TIMEOUT_SECONDS)
		.optional(),

	ttsEnabled: z.boolean().optional(),
	ttsSpeed: z.number().optional(),
	soundEnabled: z.boolean().optional(),
	soundVolume: z.number().optional(),

	maxOpenTabsContext: z.number().optional(),
	maxWorkspaceFiles: z.number().optional(),
	showRooIgnoredFiles: z.boolean().optional(),
	enableSubfolderRules: z.boolean().optional(),
	maxImageFileSize: z.number().optional(),
	maxTotalImageSize: z.number().optional(),

	terminalOutputPreviewSize: z.enum(["small", "medium", "large"]).optional(),
	terminalShellIntegrationTimeout: z.number().optional(),
	terminalShellIntegrationDisabled: z.boolean().optional(),
	terminalCommandDelay: z.number().optional(),
	terminalPowershellCounter: z.boolean().optional(),
	terminalZshClearEolMark: z.boolean().optional(),
	terminalZshOhMy: z.boolean().optional(),
	terminalZshP10k: z.boolean().optional(),
	terminalZdotdir: z.boolean().optional(),
	execaShellPath: z.string().optional(),

	diagnosticsEnabled: z.boolean().optional(),

	rateLimitSeconds: z.number().optional(),
	experiments: experimentsSchema.optional(),

	codebaseIndexModels: codebaseIndexModelsSchema.optional(),
	codebaseIndexConfig: codebaseIndexConfigSchema.optional(),

	language: languagesSchema.optional(),

	telemetrySetting: telemetrySettingsSchema.optional(),

	mcpEnabled: z.boolean().optional(),

	mode: z.string().optional(),
	modeApiConfigs: z.record(z.string(), z.string()).optional(),
	customModes: z.array(modeConfigSchema).optional(),
	customModePrompts: customModePromptsSchema.optional(),
	customSupportPrompts: customSupportPromptsSchema.optional(),
	enhancementApiConfigId: z.string().optional(),
	includeTaskHistoryInEnhance: z.boolean().optional(),
	historyPreviewCollapsed: z.boolean().optional(),
	reasoningBlockCollapsed: z.boolean().optional(),
	/**
	 * Controls the keyboard behavior for sending messages in the chat input.
	 * - "send": Enter sends message, Shift+Enter creates newline (default)
	 * - "newline": Enter creates newline, Shift+Enter/Ctrl+Enter sends message
	 * @default "send"
	 */
	enterBehavior: z.enum(["send", "newline"]).optional(),
	profileThresholds: z.record(z.string(), z.number()).optional(),
	hasOpenedModeSelector: z.boolean().optional(),
	lastModeExportPath: z.string().optional(),
	lastModeImportPath: z.string().optional(),
	lastSettingsExportPath: z.string().optional(),
	lastTaskExportPath: z.string().optional(),
	lastImageSavePath: z.string().optional(),

	/**
	 * Path to worktree to auto-open after switching workspaces.
	 * Used by the worktree feature to open the Roo Code sidebar in a new window.
	 */
	worktreeAutoOpenPath: z.string().optional(),
	/**
	 * Whether to show the worktree selector in the home screen.
	 * @default true
	 */
	showWorktreesInHomeScreen: z.boolean().optional(),

	/**
	 * List of native tool names to globally disable.
	 * Tools in this list will be excluded from prompt generation and rejected at execution time.
	 */
	disabledTools: z.array(toolNamesSchema).optional(),

	commitMessageApiConfigId: z.string().optional(),
	commitMessageGitContext: commitMessageGitContextSchema.optional(),
	commitMessageAttribution: commitMessageAttributionSchema.optional(),
	commitMessageProfiles: commitMessageProfilesSchema.optional(),
})

export type GlobalSettings = z.infer<typeof globalSettingsSchema>

export const GLOBAL_SETTINGS_KEYS = globalSettingsSchema.keyof().options

/**
 * RooCodeSettings
 */

export const rooCodeSettingsSchema = providerSettingsSchema.merge(globalSettingsSchema)

export type RooCodeSettings = GlobalSettings & ProviderSettings

/**
 * SecretState
 */
export const SECRET_STATE_KEYS = [
	"apiKey",
	"openRouterApiKey",
	"awsAccessKey",
	"awsApiKey",
	"awsSecretKey",
	"awsSessionToken",
	"openAiApiKey",
	"ollamaApiKey",
	"geminiApiKey",
	"openAiNativeApiKey",
	"deepSeekApiKey",
	"moonshotApiKey",
	"mistralApiKey",
	"minimaxApiKey",
	"requestyApiKey",
	"unboundApiKey",
	"xaiApiKey",
	"litellmApiKey",
	"codeIndexOpenAiKey",
	"codeIndexQdrantApiKey",
	"codebaseIndexOpenAiCompatibleApiKey",
	"codebaseIndexGeminiApiKey",
	"codebaseIndexMistralApiKey",
	"codebaseIndexVercelAiGatewayApiKey",
	"codebaseIndexOpenRouterApiKey",
	"sambaNovaApiKey",
	"zaiApiKey",
	"fireworksApiKey",
	"vercelAiGatewayApiKey",
	"basetenApiKey",
] as const

// Global secrets that are part of GlobalSettings (not ProviderSettings)
export const GLOBAL_SECRET_KEYS = [
	"openRouterImageApiKey", // For image generation
] as const

// Type for the actual secret storage keys
type ProviderSecretKey = (typeof SECRET_STATE_KEYS)[number]
type GlobalSecretKey = (typeof GLOBAL_SECRET_KEYS)[number]

// Type representing all secrets that can be stored
export type SecretState = Pick<ProviderSettings, Extract<ProviderSecretKey, keyof ProviderSettings>> & {
	[K in GlobalSecretKey]?: string
}

export const isSecretStateKey = (key: string): key is Keys<SecretState> =>
	SECRET_STATE_KEYS.includes(key as ProviderSecretKey) || GLOBAL_SECRET_KEYS.includes(key as GlobalSecretKey)

/**
 * GlobalState
 */

export type GlobalState = Omit<RooCodeSettings, Keys<SecretState>>

export const GLOBAL_STATE_KEYS = [...GLOBAL_SETTINGS_KEYS, ...PROVIDER_SETTINGS_KEYS].filter(
	(key: Keys<RooCodeSettings>) => !isSecretStateKey(key),
) as Keys<GlobalState>[]

export const isGlobalStateKey = (key: string): key is Keys<GlobalState> =>
	GLOBAL_STATE_KEYS.includes(key as Keys<GlobalState>)
