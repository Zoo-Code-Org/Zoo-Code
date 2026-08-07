/**
 * E2E test for the unified terminal shell selection setting (PR #1120).
 *
 * Proves that:
 *  1. `terminalShellSelection` set via the extension API round-trips through
 *     configuration persistence (set → get returns the same discriminated
 *     union value).
 *  2. Switching between selection kinds (auto → profile → path → auto)
 *     persists each value without loss.
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

	test("persists an explicit profile shell selection", async () => {
		const selection: TerminalShellSelection = { kind: "profile", profileName: "Zoo E2E Bash" }

		await globalThis.api.setConfiguration({ terminalShellSelection: selection })

		const persisted = globalThis.api.getConfiguration().terminalShellSelection
		assert.deepStrictEqual(persisted, selection, "Profile shell selection should round-trip through configuration")
	})

	test("persists an explicit path shell selection", async () => {
		const selection: TerminalShellSelection = { kind: "path", path: "/bin/zsh" }

		await globalThis.api.setConfiguration({ terminalShellSelection: selection })

		const persisted = globalThis.api.getConfiguration().terminalShellSelection
		assert.deepStrictEqual(persisted, selection, "Path shell selection should round-trip through configuration")
	})

	test("persists a reset back to auto shell selection", async () => {
		// Start from a non-auto value so the reset is a real transition.
		await globalThis.api.setConfiguration({
			terminalShellSelection: { kind: "profile", profileName: "Zoo E2E Bash" },
		})

		const selection: TerminalShellSelection = { kind: "auto" }
		await globalThis.api.setConfiguration({ terminalShellSelection: selection })

		const persisted = globalThis.api.getConfiguration().terminalShellSelection
		assert.deepStrictEqual(persisted, selection, "Auto shell selection should round-trip through configuration")
	})
})
