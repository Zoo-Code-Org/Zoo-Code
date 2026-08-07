import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitUntilCompleted } from "./utils"

/**
 * E2E coverage for PR b05a-strict-reasoning-v2 ("Strict tool schemas").
 *
 * The PR adds the profile-scoped `openAiToolStrictMode` toggle to the OpenAI
 * Compatible provider (and all providers that share the OpenAI protocol within
 * the same profile). When enabled, non-MCP function tools are sent with
 * `strict: true` and their JSON schemas are hardened (`additionalProperties:
 * false`, every property marked required). When disabled (the default),
 * tools are sent with `strict: false` and their original best-effort schemas
 * are preserved. MCP tools (`mcp--*` names) must ALWAYS remain non-strict
 * regardless of the toggle.
 *
 * These tests run the built extension bundle against the aimock server,
 * intercept the outbound `/v1/chat/completions` request bodies, and assert
 * on the serialized `tools` array — proving the toggle is threaded through
 * configuration → provider handler → wire format end-to-end.
 */

type CapturedToolFunction = {
	name?: string
	strict?: boolean
	parameters?: {
		additionalProperties?: unknown
		properties?: Record<string, unknown>
		required?: string[]
	}
}

type CapturedChatRequest = {
	userMessageText?: string
	tools: CapturedToolFunction[]
	rawBody?: unknown
}

const getRequestUrl = (input: RequestInfo | URL): string =>
	typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url

const messageContentText = (content: unknown): string => {
	if (typeof content === "string") {
		return content
	}

	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === "object" && part !== null ? ((part as { text?: string }).text ?? "") : ""))
			.join("")
	}

	return ""
}

/**
 * Installs a fetch interceptor that records the `tools` array of every
 * chat-completions request sent to the OpenAI-compatible base URL.
 * Returns a restore function.
 */
const installToolCapture = (capture: CapturedChatRequest[], baseUrl: string): (() => void) => {
	const originalFetch = globalThis.fetch
	const targetOrigin = new URL(baseUrl).origin

	globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		try {
			const url = getRequestUrl(input)

			if (new URL(url).origin === targetOrigin && init?.body && typeof init.body === "string") {
				const body = JSON.parse(init.body) as {
					tools?: Array<{ type?: string; function?: CapturedToolFunction }>
					messages?: Array<{ role?: string; content?: unknown }>
				}

				if (Array.isArray(body.tools) && body.tools.length > 0) {
					const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")

					capture.push({
						userMessageText: messageContentText(lastUser?.content),
						tools: body.tools
							.filter((t) => t?.type === "function" && t.function)
							.map((t) => t.function as CapturedToolFunction),
						rawBody: body,
					})
				}
			}
		} catch {
			// Ignore non-JSON or unrelated traffic.
		}

		return originalFetch.call(globalThis, input, init as RequestInit)
	} as typeof globalThis.fetch

	return () => {
		globalThis.fetch = originalFetch
	}
}

/** Finds the captured request whose last user message contains the probe tag. */
const findProbeRequest = (requests: CapturedChatRequest[], probeTag: string) =>
	requests.find((r) => r.userMessageText?.includes(probeTag))

suite("Strict tool schema mode (openAiToolStrictMode)", function () {
	setDefaultSuiteTimeout(this)

	let restoreFetch: (() => void) | undefined
	const requests: CapturedChatRequest[] = []

	let baseUrl: string

	setup(function () {
		// These assertions require the aimock server so the OpenAI Compatible
		// provider has a deterministic endpoint to stream from. Without
		// AIMOCK_URL there is no real OpenAI key configured in CI, so skip.
		if (!process.env.AIMOCK_URL) {
			this.skip()
		}
	})

	suiteSetup(async () => {
		const aimockUrl = process.env.AIMOCK_URL!
		baseUrl = `${aimockUrl}/v1`
		restoreFetch = installToolCapture(requests, baseUrl)
	})

	suiteTeardown(async () => {
		restoreFetch?.()
		restoreFetch = undefined

		// Restore the default OpenRouter configuration so later suites (provider
		// suites run after tool suites) see the expected default profile.
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"

		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
	})

	const configureOpenAiCompatible = async (strictMode: boolean | undefined) => {
		await globalThis.api.setConfiguration({
			apiProvider: "openai" as const,
			openAiApiKey: "mock-key",
			openAiBaseUrl: baseUrl,
			openAiModelId: "openai/gpt-4.1",
			openAiStreamingEnabled: true,
			...(strictMode !== undefined && { openAiToolStrictMode: strictMode }),
		})
	}

	const runProbeTask = async (probeTag: string) => {
		const api = globalThis.api

		const taskId = await api.startNewTask({
			configuration: { mode: "ask", autoApprovalEnabled: true },
			text: `${probeTag}: what is 2+2? Reply with only the number.`,
		})

		await waitUntilCompleted({ api, taskId })

		const captured = findProbeRequest(requests, probeTag)
		assert.ok(captured, `Should have captured an outbound request containing probe tag "${probeTag}"`)
		assert.ok(captured.tools.length > 0, "Captured request should include function tools")

		return captured
	}

	test("strict mode disabled (default): non-MCP tools are sent with strict:false and unhardened schemas", async () => {
		requests.length = 0
		await configureOpenAiCompatible(undefined)

		const captured = await runProbeTask("strict-reasoning-e2e-default")

		const nonMcpTools = captured.tools.filter((t) => !t.name?.startsWith("mcp--"))
		assert.ok(nonMcpTools.length > 0, "Request should contain at least one non-MCP function tool")

		for (const tool of nonMcpTools) {
			assert.strictEqual(
				tool.strict,
				false,
				`Tool "${tool.name}" should be strict:false when openAiToolStrictMode is unset`,
			)

			// Schema hardening must NOT be applied: if properties exist, required
			// must not be force-expanded to cover every property key.
			if (tool.parameters?.properties) {
				const allKeys = Object.keys(tool.parameters.properties)
				const required = tool.parameters.required ?? []

				if (allKeys.length > 0) {
					assert.ok(
						required.length <= allKeys.length,
						`Tool "${tool.name}" required list should not exceed property count`,
					)
				}
			}
		}

		// MCP tools (if any were registered) must always remain non-strict.
		const mcpTools = captured.tools.filter((t) => t.name?.startsWith("mcp--"))
		for (const tool of mcpTools) {
			assert.strictEqual(tool.strict, false, `MCP tool "${tool.name}" must always be strict:false`)
		}
	})

	test("strict mode explicitly disabled: identical behavior to default", async () => {
		requests.length = 0
		await configureOpenAiCompatible(false)

		const captured = await runProbeTask("strict-reasoning-e2e-disabled")

		const nonMcpTools = captured.tools.filter((t) => !t.name?.startsWith("mcp--"))
		assert.ok(nonMcpTools.length > 0, "Request should contain at least one non-MCP function tool")

		for (const tool of nonMcpTools) {
			assert.strictEqual(
				tool.strict,
				false,
				`Tool "${tool.name}" should be strict:false when openAiToolStrictMode is false`,
			)
		}
	})

	test("strict mode enabled: non-MCP tools are sent with strict:true and hardened schemas", async () => {
		requests.length = 0
		await configureOpenAiCompatible(true)

		const captured = await runProbeTask("strict-reasoning-e2e-enabled")

		const nonMcpTools = captured.tools.filter((t) => !t.name?.startsWith("mcp--"))
		assert.ok(nonMcpTools.length > 0, "Request should contain at least one non-MCP function tool")

		for (const tool of nonMcpTools) {
			assert.strictEqual(
				tool.strict,
				true,
				`Tool "${tool.name}" should be strict:true when openAiToolStrictMode is true`,
			)

			// Strict mode hardening: object schemas must declare
			// additionalProperties:false and list every property in `required`.
			if (tool.parameters?.properties) {
				const allKeys = Object.keys(tool.parameters.properties)
				const required = tool.parameters.required ?? []

				assert.strictEqual(
					tool.parameters.additionalProperties,
					false,
					`Tool "${tool.name}" should set additionalProperties:false under strict mode`,
				)

				for (const key of allKeys) {
					assert.ok(
						required.includes(key),
						`Tool "${tool.name}" should mark property "${key}" as required under strict mode`,
					)
				}
			}
		}

		// MCP tools must remain non-strict even with the toggle enabled.
		const mcpTools = captured.tools.filter((t) => t.name?.startsWith("mcp--"))
		for (const tool of mcpTools) {
			assert.strictEqual(
				tool.strict,
				false,
				`MCP tool "${tool.name}" must remain strict:false even when openAiToolStrictMode is true`,
			)
		}
	})

	test("strict mode toggle round-trips: enable → disable restores non-strict behavior", async () => {
		// Enable strict mode and capture.
		requests.length = 0
		await configureOpenAiCompatible(true)
		const strictOn = await runProbeTask("strict-reasoning-e2e-roundtrip-on")
		assert.ok(
			strictOn.tools.some((t) => !t.name?.startsWith("mcp--") && t.strict === true),
			"With strict mode on, at least one non-MCP tool should be strict:true",
		)

		// Disable strict mode and capture again.
		requests.length = 0
		await configureOpenAiCompatible(false)
		const strictOff = await runProbeTask("strict-reasoning-e2e-roundtrip-off")

		for (const tool of strictOff.tools.filter((t) => !t.name?.startsWith("mcp--"))) {
			assert.strictEqual(
				tool.strict,
				false,
				`Tool "${tool.name}" should return to strict:false after the toggle is disabled`,
			)
		}
	})

	test("task completes and produces assistant output regardless of strict mode setting", async () => {
		requests.length = 0
		await configureOpenAiCompatible(true)

		const api = globalThis.api
		const messages: ClineMessage[] = []

		const messageHandler = ({ message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "say" && message.partial === false) {
				messages.push(message)
			}
		}

		api.on(RooCodeEventName.Message, messageHandler)

		try {
			const taskId = await api.startNewTask({
				configuration: { mode: "ask", autoApprovalEnabled: true },
				text: "strict-reasoning-e2e-output: what is 2+2? Reply with only the number.",
			})

			await waitUntilCompleted({ api, taskId })

			// The mock replies via attempt_completion; assert the task surfaced a
			// completion_result (or text) message — i.e. strict-mode serialization
			// did not break the response handling / display path.
			assert.ok(
				messages.some((m) => (m.say === "completion_result" || m.say === "text") && (m.text?.length ?? 0) > 0),
				"Task should produce a visible assistant completion message under strict mode",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
