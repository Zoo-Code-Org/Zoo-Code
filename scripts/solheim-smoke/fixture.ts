import type { AgentFixture } from "../agent-evals/contract.ts"
import { registerFixture } from "../agent-evals/registry.ts"
import { SMOKE_TIMEOUT_MS, SMOKE_PROMPT, SOLHEIM_BASE_URL, SOLHEIM_MODEL, buildSmokeConfiguration } from "./config.ts"

export const SMOKE_FIXTURE_NAME = "solheim-smoke"
const SMOKE_FIXTURE_VERSION = "1.0.0"
const ROLE_DEFINITION = "Complete one connectivity smoke task. You are not a reviewer."
const DISABLED_TOOLS = [
	"ask_followup_question",
	"new_task",
	"switch_mode",
	"update_todo_list",
	"skill",
	"run_slash_command",
] as const

// The first trusted fixture: the no-tools deterministic provider smoke on an
// empty workspace. The projection is the explicit nonsecret mirror of the
// built configuration; the trace digests it and never sees the credential.
export function buildSmokeFixture(): AgentFixture {
	return {
		identity: {
			name: SMOKE_FIXTURE_NAME,
			version: SMOKE_FIXTURE_VERSION,
			description: "No-tools deterministic provider connectivity smoke on an empty workspace.",
		},
		prompt: SMOKE_PROMPT,
		workspace: { files: [] },
		toolPolicy: {
			mode: "provider-smoke",
			roleDefinition: ROLE_DEFINITION,
			groups: [],
			disabledTools: [...DISABLED_TOOLS],
			allow: {
				readOnly: false,
				readOnlyOutsideWorkspace: false,
				write: false,
				writeOutsideWorkspace: false,
				writeProtected: false,
				execute: false,
				mcp: false,
				modeSwitch: false,
				subtasks: false,
				followupQuestions: false,
			},
		},
		limits: {
			activationTimeoutMs: SMOKE_TIMEOUT_MS,
			taskStartTimeoutMs: 35_000,
			taskRunTimeoutMs: SMOKE_TIMEOUT_MS,
			usageDrainMs: 5_000,
			teardownStepMs: 5_000,
		},
		settingsProjection: {
			apiProvider: "openai",
			openAiBaseUrl: SOLHEIM_BASE_URL,
			openAiModelId: SOLHEIM_MODEL,
			openAiR1FormatEnabled: true,
			openAiExtraBody: { chat_template_kwargs: { enable_thinking: false } },
			modelMaxTokens: 512,
			autoCondenseContext: false,
			mode: "provider-smoke",
			customModes: [
				{ slug: "provider-smoke", name: "Provider smoke", roleDefinition: ROLE_DEFINITION, groups: [] },
			],
			disabledTools: [...DISABLED_TOOLS],
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: false,
			alwaysAllowReadOnlyOutsideWorkspace: false,
			alwaysAllowWrite: false,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowWriteProtected: false,
			alwaysAllowExecute: false,
			alwaysAllowMcp: false,
			alwaysAllowModeSwitch: false,
			alwaysAllowSubtasks: false,
			alwaysAllowFollowupQuestions: false,
		},
		buildConfiguration: buildSmokeConfiguration,
	}
}

let registered = false

export function ensureSmokeFixtureRegistered(): void {
	if (registered) return
	registered = true
	registerFixture(buildSmokeFixture())
}
