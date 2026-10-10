import path from "node:path"
import type { RooCodeSettings } from "@roo-code/types"

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

// Inherit only host-launch necessities, never the credential-bearing parent environment.
export function buildChildEnvironment(
	env: NodeJS.ProcessEnv,
	isolatedHome: string,
	socketPath: string,
): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = {}
	for (const name of ["PATH", "DISPLAY", "XAUTHORITY", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "WINDIR"])
		if (env[name]) child[name] = env[name]
	return {
		...child,
		HOME: isolatedHome,
		USERPROFILE: isolatedHome,
		XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
		XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
		ROO_CODE_IPC_SOCKET_PATH: socketPath,
	}
}

export function buildLaunchArgs(workspace: string, userData: string, extensions: string, extension: string): string[] {
	return [
		workspace,
		`--user-data-dir=${userData}`,
		`--extensions-dir=${extensions}`,
		`--extensionDevelopmentPath=${extension}`,
		"--no-sandbox",
		"--disable-gpu-sandbox",
		"--password-store=basic",
		"--disable-updates",
		"--skip-welcome",
		"--skip-release-notes",
		"--disable-workspace-trust",
	]
}
