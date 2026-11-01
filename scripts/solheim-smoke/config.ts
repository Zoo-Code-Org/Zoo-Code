import type { RooCodeSettings } from "@roo-code/types"

export { buildChildEnvironment, buildLaunchArgs } from "../agent-evals/isolation.ts"

export const SOLHEIM_BASE_URL = "https://api.solheim.ai/v1"
export const SOLHEIM_MODEL = "qwen3.8-27b"
export const SMOKE_TIMEOUT_MS = 120_000
export const SMOKE_PROMPT =
	"This is a provider connectivity smoke test, not a code review. Call attempt_completion once with the result: Provider smoke completed. Do not read files, use other tools, delegate, or judge code."

export function buildSmokeConfiguration(apiKey: string): RooCodeSettings {
	return {
		apiProvider: "openai",
		openAiBaseUrl: SOLHEIM_BASE_URL,
		openAiApiKey: apiKey,
		openAiModelId: SOLHEIM_MODEL,
		openAiR1FormatEnabled: true,
		openAiExtraBody: JSON.stringify({ chat_template_kwargs: { enable_thinking: false } }),
		modelMaxTokens: 512,
		autoCondenseContext: false,
		mode: "provider-smoke",
		customModes: [
			{
				slug: "provider-smoke",
				name: "Provider smoke",
				roleDefinition: "Complete one connectivity smoke task. You are not a reviewer.",
				groups: [],
			},
		],
		disabledTools: [
			"ask_followup_question",
			"new_task",
			"switch_mode",
			"update_todo_list",
			"skill",
			"run_slash_command",
		],
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
	}
}
