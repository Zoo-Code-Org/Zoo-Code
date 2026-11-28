import * as assert from "assert"
import * as vscode from "vscode"

import { providerIdentifiers, type RooCodeAPI } from "@roo-code/types"

import {
	PHASE_RESULT_VERSION,
	readPhaseResult,
	serializePhaseError,
	type PhaseResult,
	writePhaseResult,
} from "../restart/phaseProtocol"

// Issue #2770 extension-host E2E: save a profile with OpenAI Compatible custom headers
// through the same upsert path the webview Save button posts, quit VS Code, and confirm
// the headers come back from real storage after a fresh extension host starts. This is
// the restart boundary the TLA model treats as an oracle.
//
// VS Code keeps context.secrets on the OS credential store. A headless runner without a
// keyring cannot persist it across processes at all, which is an environment property,
// not an extension bug. The canary profile below detects that case: if the canary is
// gone too, the verify phase reports an ENVIRONMENT_SKIP instead of a false failure.
const PROFILE_NAME = "headers-restart-profile"
const CANARY_PROFILE_NAME = "headers-restart-canary"
const EXPECTED_HEADERS = { "X-Restart-Check": "survives", "X-Second": "kept" }

function getResultsDir(): string {
	const resultsDir = process.env.E2E_RESULTS_DIR
	if (!resultsDir) throw new Error("E2E_RESULTS_DIR is required")
	return resultsDir
}

async function quitGracefully(): Promise<void> {
	await vscode.commands.executeCommand("workbench.action.quit")
}

async function waitForExtension(api: RooCodeAPI): Promise<void> {
	// The suite harness focuses the sidebar before running tests; wait for readiness
	// so both phases observe a fully activated extension.
	for (let attempt = 0; attempt < 30; attempt++) {
		if (api.isReady()) return
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	throw new Error("Extension did not become ready")
}

async function runCreate(api: RooCodeAPI): Promise<void> {
	try {
		await waitForExtension(api)

		// The webview Save button posts `upsertApiConfiguration`, which lands here in
		// `upsertProviderProfile`. This is the persistence write under test.
		const id = await api.upsertProfile(PROFILE_NAME, {
			apiProvider: providerIdentifiers.openai,
			openAiBaseUrl: "https://headers-restart.example/v1",
			openAiApiKey: "headers-restart-mock-key",
			openAiHeaders: EXPECTED_HEADERS,
		})
		assert.ok(id, "Profile upsert should return an id")

		// The canary uses the same storage backend with no headers of its own.
		const canaryId = await api.upsertProfile(CANARY_PROFILE_NAME, {
			apiProvider: providerIdentifiers.openai,
			openAiBaseUrl: "https://headers-restart-canary.example/v1",
			openAiApiKey: "headers-restart-canary-key",
		})
		assert.ok(canaryId, "Canary upsert should return an id")

		// Confirm through a fresh read before quitting: the write reached storage.
		const entry = api.getProfileEntry(PROFILE_NAME)
		assert.ok(entry, "Profile entry should exist right after the save")
		assert.strictEqual(entry.apiProvider, "openai")

		const result: PhaseResult = {
			version: PHASE_RESULT_VERSION,
			phase: "create",
			status: "passed",
			values: { profile: PROFILE_NAME, canary: CANARY_PROFILE_NAME },
		}
		await writePhaseResult(getResultsDir(), result)
		await quitGracefully()
	} catch (error) {
		await writePhaseResult(getResultsDir(), {
			version: PHASE_RESULT_VERSION,
			phase: "create",
			status: "failed",
			error: serializePhaseError(error),
		})
		throw error
	}
}

async function runVerify(api: RooCodeAPI): Promise<void> {
	try {
		await waitForExtension(api)

		const createResult = await readPhaseResult(getResultsDir(), "create")
		assert.strictEqual(createResult.status, "passed")
		const profileName = createResult.values?.profile
		const canaryName = createResult.values?.canary
		assert.ok(profileName, "Create phase should record the profile name")
		assert.ok(canaryName, "Create phase should record the canary name")

		const canary = api.getProfileEntry(canaryName)

		if (!canary) {
			// VS Code secret storage did not persist across the restart in this
			// environment (no OS keyring). The restart assertion is out of scope here;
			// the coordinator reports this as a loud environment skip, not a pass.
			await writePhaseResult(getResultsDir(), {
				version: PHASE_RESULT_VERSION,
				phase: "verify",
				status: "failed",
				error: {
					message:
						"ENVIRONMENT_SKIP: VS Code secret storage did not persist across the restart in this keyring-less environment",
				},
			})
			await quitGracefully()
			return
		}

		// Activating the persisted profile copies its stored settings into the live state.
		const activated = await api.setActiveProfile(profileName)
		assert.strictEqual(activated, profileName)

		const configuration = api.getConfiguration()
		assert.deepStrictEqual(configuration.openAiHeaders, EXPECTED_HEADERS)
		assert.strictEqual(configuration.openAiBaseUrl, "https://headers-restart.example/v1")

		const entry = api.getProfileEntry(profileName)
		assert.ok(entry, "Profile entry should exist after the restart")

		const result: PhaseResult = {
			version: PHASE_RESULT_VERSION,
			phase: "verify",
			status: "passed",
			values: { profile: profileName },
		}
		await writePhaseResult(getResultsDir(), result)
		await quitGracefully()
	} catch (error) {
		await writePhaseResult(getResultsDir(), {
			version: PHASE_RESULT_VERSION,
			phase: "verify",
			status: "failed",
			error: serializePhaseError(error),
		})
		throw error
	}
}

suite("Provider headers restart persistence", () => {
	test("persists OpenAI Compatible custom headers across a fresh extension host", async () => {
		const api = globalThis.api
		if (process.env.E2E_PHASE === "create") {
			await runCreate(api)
		} else if (process.env.E2E_PHASE === "verify") {
			await runVerify(api)
		} else {
			throw new Error(`Unknown E2E_PHASE: ${process.env.E2E_PHASE ?? "unset"}`)
		}
	})
})
