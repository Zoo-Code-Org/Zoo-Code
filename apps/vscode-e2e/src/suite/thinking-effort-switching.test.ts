import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { withOpenRouterCaptureProxy, type CapturedDteRequest } from "./thinking-effort-proxy"
import { setDefaultSuiteTimeout } from "./test-utils"
import { waitUntilCompleted, waitFor } from "./utils"

/**
 * DTE addendum: set_thinking_effort switching within a single task.
 *
 * Complements thinking-effort-tool.test.ts (single apply) by driving one task
 * through a scripted switching sequence and asserting the per-request wire
 * envelope after every call:
 *
 *   baseline (settings reasoningEffort "low")
 *     -> set "medium"  applied  -> next request sends { effort: "medium" }
 *     -> set "medium"  no-op    -> next request still "medium" (result: "already 'medium'", no display say)
 *     -> set "high"    applied  -> next request sends { effort: "high" }
 *     -> set "medium"  refused  -> next request still "high" (A -> B -> A oscillation refusal)
 *     -> attempt_completion
 *
 * Determinism notes:
 * - Runs against aimock only (replay or record); skips when aimock is absent,
 *   so no API keys are required.
 * - The capture proxy is shared with thinking-effort-tool.test.ts via
 *   ./thinking-effort-proxy: it intercepts the OpenRouter-compatible
 *   chat/completions POST (so request shapes can be asserted) and forwards it
 *   to aimock for the fixture-driven SSE responses.
 * - Model: openai/gpt-5.1, which advertises "reasoning" in supported_parameters
 *   in the public OpenRouter catalog, so the model-cache fetcher resolves
 *   supportsReasoningEffort: true and the dynamicThinkingEffort gate exposes
 *   the tool. The suite picks a model that no other fixture file uses, and the
 *   fixtures are scoped by model, so the two DTE suites cannot cross-match.
 * - Baseline: the suite sets reasoningEffort "low" explicitly. setConfiguration
 *   replaces the whole provider profile (ProviderSettingsManager.saveConfig),
 *   so the baseline is deterministic and cannot inherit state from other
 *   suites; "low" is distinct from every level the tool applies here.
 * - Fixture matching (apps/vscode-e2e/src/fixtures/thinking-effort.ts):
 *   post-tool requests end with a role:user message (fresh environment details
 *   are appended after the tool result), so aimock's toolCallId matcher — which
 *   requires the LAST message to be role:tool — can never bind the continuation
 *   turns, and a JSON fixture cannot carry a predicate. The fixtures live in a
 *   JS module added via addThinkingEffortFixtures (same pattern as
 *   deepseek-v4.ts): the baseline turn binds to this suite's unique prompt
 *   marker ("DTE_E2E_SWITCH"), and every continuation binds to the previous
 *   turn's unique tool call id (call_dte_sw_001 → 002 → 003 → 004 →
 *   completion), so no other suite can serve these responses and this suite
 *   cannot match unrelated turns.
 */

const SWITCH_MODEL_ID = "openai/gpt-5.1"
const BASELINE_EFFORT = "low"
const SWITCH_MARKER = "DTE_E2E_SWITCH"
const COMPLETION_EXPECTED = "DTE_E2E_SWITCH_DONE"

// Tool call ids; the first request whose body carries call N is the request
// made right after call N executed, so its reasoning envelope reflects N's outcome.
const CALL_APPLY_MEDIUM = "call_dte_sw_001"
const CALL_NOOP_MEDIUM = "call_dte_sw_002"
const CALL_APPLY_HIGH = "call_dte_sw_003"
const CALL_REFUSED_MEDIUM = "call_dte_sw_004"

type ThinkingEffortSay = {
	tool?: string
	effort?: string
	reason?: string
	refusal?: string
}

/**
 * Finds the first captured wire request whose body carries the given tool
 * call id — i.e. the post-tool request that follows a specific tool call.
 */
function firstRequestCarrying(requests: CapturedDteRequest[], callId: string): CapturedDteRequest | undefined {
	return requests.find((request) => request.bodyText.includes(callId))
}

suite("set_thinking_effort switching within a task (DTE addendum)", function () {
	setDefaultSuiteTimeout(this)

	// Restore the provider profile defaults so subsequent suites are unaffected.
	// setConfiguration merges per-key into ContextProxy (setValues ->
	// updateGlobalState), so the experiment flag and this suite's reasoning
	// envelope (enableReasoningEffort + baseline reasoningEffort) are explicitly
	// cleared below.
	suiteTeardown(async () => {
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
			experiments: { dynamicThinkingEffort: false },
			// Clear this suite's reasoning envelope so later suites do not inherit
			// a persisted enableReasoningEffort / reasoningEffort pair (undefined
			// deletes the key via Memento.update semantics).
			enableReasoningEffort: false,
			reasoningEffort: undefined,
		})
	})

	test("Should apply and refuse effort switches, updating the wire envelope only on applied changes", async function () {
		const api = globalThis.api
		const aimockUrl = process.env.AIMOCK_URL

		// Deterministic, key-free: aimock replay/record only. A live run would need
		// a real model that deterministically emits the scripted switching sequence.
		if (!aimockUrl) {
			this.skip()
		}

		await withOpenRouterCaptureProxy(aimockUrl, async ({ proxyUrl, requests }) => {
			// OpenRouter provider, a model that advertises per-request reasoning effort
			// (public catalog: "reasoning" in supported_parameters), the
			// dynamicThinkingEffort experiment enabled, and an explicit baseline effort so
			// the baseline request carries a deterministic { effort: "low" } envelope.
			await api.setConfiguration({
				apiProvider: "openrouter" as const,
				openRouterApiKey: "mock-key",
				openRouterModelId: SWITCH_MODEL_ID,
				openRouterBaseUrl: `${proxyUrl}/v1`,
				enableReasoningEffort: true,
				reasoningEffort: BASELINE_EFFORT,
				experiments: { dynamicThinkingEffort: true },
			})

			const messages: ClineMessage[] = []
			const onMessage = ({ message }: { message: ClineMessage }) => {
				if (message.type === "say" && message.partial === false) {
					messages.push(message)
				}
			}
			api.on(RooCodeEventName.Message, onMessage)

			const taskId = await api.startNewTask({
				configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
				text: SWITCH_MARKER + ": manage the thinking effort for this task",
			})

			const countEffortSays = () =>
				messages.filter(
					({ say, text }) => say === "tool" && typeof text === "string" && text.includes("thinkingEffort"),
				).length

			await waitUntilCompleted({ api, taskId })

			// Event delivery race: the final display say can be observed after the
			// TaskCompleted event (separate event channels, no cross-channel
			// ordering guarantee). Settle the expected display says before
			// detaching the listener; a genuine shortfall still fails below.
			await waitFor(() => countEffortSays() >= 3, { timeout: 5_000, interval: 100 })

			api.off(RooCodeEventName.Message, onMessage)

			// (a) Real boundary: the task completes after the full switching sequence.
			const completion = messages.find(
				({ say, text }) =>
					(say === "completion_result" || say === "text") && text?.trim() === COMPLETION_EXPECTED,
			)
			assert.ok(
				completion,
				"Task should complete with '" + COMPLETION_EXPECTED + "' after the switching sequence",
			)

			// (b) Real boundary: display says carry the applied efforts and the refusal;
			// the no-op call deliberately emits no display say.
			const effortSays = messages
				.filter(
					({ say, text }) => say === "tool" && typeof text === "string" && text.includes("thinkingEffort"),
				)
				.map(({ text }) => JSON.parse(text ?? "") as ThinkingEffortSay)
			assert.strictEqual(effortSays.length, 3, "Should emit exactly three thinkingEffort display says")

			const appliedMedium = effortSays.find((say) => say.effort === "medium")
			assert.ok(appliedMedium, "Should emit an applied 'medium' display say")
			assert.strictEqual(
				appliedMedium?.reason,
				"start at medium",
				"The 'medium' say should carry the model's reason",
			)
			assert.strictEqual(
				appliedMedium?.refusal,
				undefined,
				"The 'medium' change should have been applied, not refused",
			)

			const appliedHigh = effortSays.find((say) => say.effort === "high")
			assert.ok(appliedHigh, "Should emit an applied 'high' display say")
			assert.strictEqual(appliedHigh?.reason, "raise to high", "The 'high' say should carry the model's reason")
			assert.strictEqual(
				appliedHigh?.refusal,
				undefined,
				"The 'high' change should have been applied, not refused",
			)

			const refusal = effortSays.find((say) => say.refusal === "oscillation")
			assert.ok(refusal, "The A -> B -> A return (medium -> high -> medium) should be refused as oscillation")
			assert.strictEqual(refusal?.effort, undefined, "A refused say must not carry an applied effort")

			// (c) Real boundary: the wire envelope per request. Each request below is the
			// first one carrying the given tool call id, i.e. the request made right after
			// that call executed, so its reasoning envelope reflects the call's outcome.
			const baselineRequest = requests.find((request) => request.lastUserMessage.includes(SWITCH_MARKER))
			assert.ok(baselineRequest, "Should have captured the baseline request containing the task prompt")
			assert.strictEqual(baselineRequest.model, SWITCH_MODEL_ID)
			assert.strictEqual(
				baselineRequest.reasoning?.effort,
				BASELINE_EFFORT,
				"The baseline request should carry the settings-derived baseline effort",
			)

			const afterApplyMedium = firstRequestCarrying(requests, CALL_APPLY_MEDIUM)
			assert.ok(afterApplyMedium, "Should have captured the request after the 'medium' change was applied")
			assert.strictEqual(
				afterApplyMedium.reasoning?.effort,
				"medium",
				"The request after the applied change should send the 'medium' effort",
			)
			assert.ok(
				afterApplyMedium.bodyText.includes("Thinking effort is now 'medium'."),
				"The tool result after the applied change should confirm the new effort",
			)

			const afterNoOp = firstRequestCarrying(requests, CALL_NOOP_MEDIUM)
			assert.ok(afterNoOp, "Should have captured the request after the no-op change")
			assert.strictEqual(
				afterNoOp.reasoning?.effort,
				"medium",
				"A no-op change must not alter the effort envelope",
			)
			assert.ok(
				afterNoOp.bodyText.includes("Thinking effort is already 'medium'."),
				"The no-op tool result should confirm the current effort",
			)

			const afterApplyHigh = firstRequestCarrying(requests, CALL_APPLY_HIGH)
			assert.ok(afterApplyHigh, "Should have captured the request after the 'high' change was applied")
			assert.strictEqual(
				afterApplyHigh.reasoning?.effort,
				"high",
				"The request after the applied change should send the 'high' effort",
			)
			assert.ok(
				afterApplyHigh.bodyText.includes("Thinking effort is now 'high'."),
				"The tool result after the applied change should confirm the new effort",
			)

			const afterRefusal = firstRequestCarrying(requests, CALL_REFUSED_MEDIUM)
			assert.ok(afterRefusal, "Should have captured the request after the refused change")
			assert.strictEqual(
				afterRefusal.reasoning?.effort,
				"high",
				"A refused change must not alter the effort envelope",
			)
			assert.ok(
				afterRefusal.bodyText.includes("oscillation between 'medium' and 'high' detected"),
				"The refusal tool result should name the oscillation",
			)
		})
	})
})
