import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
	buildChildEnvironment,
	buildLaunchArgs,
	buildSmokeConfiguration,
	SOLHEIM_BASE_URL,
	SOLHEIM_MODEL,
	SMOKE_PROMPT,
} from "./config.ts"

describe("Solheim provider smoke configuration", () => {
	it("uses one fixed provider and a small output budget", () => {
		const config = buildSmokeConfiguration("test-credential")
		assert.equal(config.openAiBaseUrl, SOLHEIM_BASE_URL)
		assert.equal(config.openAiModelId, SOLHEIM_MODEL)
		assert.equal(config.openAiApiKey, "test-credential")
		assert.equal(config.modelMaxTokens, 512)
		assert.deepEqual(JSON.parse(config.openAiExtraBody ?? ""), { chat_template_kwargs: { enable_thinking: false } })
	})
	it("is a no-tools infrastructure task, with no delegation or reviewer instructions", () => {
		const config = buildSmokeConfiguration("test-credential")
		assert.deepEqual(config.customModes?.[0]?.groups, [])
		assert.equal(config.mode, "provider-smoke")
		for (const name of [
			"alwaysAllowWrite",
			"alwaysAllowExecute",
			"alwaysAllowMcp",
			"alwaysAllowSubtasks",
			"alwaysAllowReadOnly",
		] as const)
			assert.equal(config[name], false)
		assert.ok(config.disabledTools?.includes("new_task"))
		assert.ok(config.disabledTools?.includes("ask_followup_question"))
		assert.match(SMOKE_PROMPT, /not a code review/)
	})
	it("passes only allowlisted host variables into the isolated extension host", () => {
		const env = buildChildEnvironment(
			{
				PATH: "/bin",
				DISPLAY: ":1",
				SOLHEIM_API_KEY: "secret",
				GITHUB_TOKEN: "token",
				NODE_OPTIONS: "--require=bad.js",
				XDG_CONFIG_HOME: "/real-home",
				EXTRA_CREDENTIAL: "other",
			},
			"/tmp/isolated",
			"/tmp/ipc",
		)
		assert.equal(env.PATH, "/bin")
		assert.equal(env.DISPLAY, ":1")
		assert.equal(env.HOME, "/tmp/isolated")
		assert.equal(env.XDG_CONFIG_HOME, "/tmp/isolated/.config")
		for (const name of ["SOLHEIM_API_KEY", "GITHUB_TOKEN", "NODE_OPTIONS", "EXTRA_CREDENTIAL"])
			assert.equal(env[name], undefined)
	})
	it("uses isolated storage and a keyring-free launch", () => {
		const args = buildLaunchArgs("/empty-workspace", "/data", "/extensions", "/extension")
		assert.equal(args[0], "/empty-workspace")
		assert.ok(args.includes("--password-store=basic"))
		assert.ok(args.includes("--extensionDevelopmentPath=/extension"))
		assert.ok(args.includes("--user-data-dir=/data"))
	})
})
