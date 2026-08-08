/**
 * E2E smoke test for the unified terminal shell selection setting (PR #1120).
 *
 * Scope note (CodeRabbit review): the profile/path/auto round-trip permutations
 * are pure configuration-persistence concerns and are covered by unit tests in
 * `packages/types/src/__tests__/terminal-shell-settings.spec.ts` (schema
 * validation) and `webview-ui/src/components/settings/__tests__/SettingsView.shell-selection.spec.tsx`
 * (Save → setTerminalShellSelection message wiring). This E2E file keeps only a
 * minimal smoke test proving the setting survives a real extension-host
 * set → get round-trip end to end.
 *
 * This test is platform-independent: it exercises the settings contract, not
 * actual shell invocation, so it runs on Windows/macOS/Linux without a real
 * shell binary requirement.
 */
import * as assert from "assert"

import type { TerminalShellSelection } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"

suite("Terminal Shell Settings", function () {
	setDefaultSuiteTimeout(this)

	let originalSelection: TerminalShellSelection | undefined

	suiteSetup(async () => {
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"

		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "anthropic/claude-sonnet-4.5",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})

		// Preserve the current selection so teardown can restore it.
		originalSelection = globalThis.api.getConfiguration().terminalShellSelection
	})

	suiteTeardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// task may not be running
		}

		await globalThis.api.setConfiguration({ terminalShellSelection: originalSelection })

		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
	})

	test("smoke: terminal shell selection round-trips through the extension host", async () => {
		const selection: TerminalShellSelection = { kind: "profile", profileName: "Zoo E2E Bash" }

		await globalThis.api.setConfiguration({ terminalShellSelection: selection })

		const persisted = globalThis.api.getConfiguration().terminalShellSelection
		assert.deepStrictEqual(persisted, selection, "Shell selection should round-trip through configuration")
	})
})
