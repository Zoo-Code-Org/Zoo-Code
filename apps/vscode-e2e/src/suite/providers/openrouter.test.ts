import * as assert from "assert"

import { setDefaultSuiteTimeout } from "../test-utils"
import { waitUntilCompleted } from "../utils"

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY

type CapturedOpenRouterRequest = {
	xTitle: string | undefined
	httpReferer: string | undefined
	userAgent: string | undefined
}

function getRequestUrl(input: RequestInfo | URL): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
}

function getHeaderValue(init: RequestInit | undefined, name: string): string | undefined {
	if (!init?.headers) return undefined
	const lower = name.toLowerCase()
	if (Array.isArray(init.headers)) {
		const found = (init.headers as string[][]).find(([k]) => k?.toLowerCase() === lower)
		return found?.[1]
	}
	if (init.headers instanceof Headers) {
		return init.headers.get(name) ?? undefined
	}
	const record = init.headers as Record<string, string>
	return record[name] ?? Object.entries(record).find(([k]) => k.toLowerCase() === lower)?.[1]
}

function installOpenRouterRequestCapture(capture: CapturedOpenRouterRequest[], baseUrl: string): () => void {
	const originalFetch = globalThis.fetch
	const targetOrigin = new URL(baseUrl).origin

	globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = getRequestUrl(input)

		try {
			if (new URL(url).origin === targetOrigin) {
				const xTitle = getHeaderValue(init, "X-Title") ?? getHeaderValue(init, "x-title")
				if (xTitle !== undefined) {
					capture.push({
						xTitle,
						httpReferer: getHeaderValue(init, "HTTP-Referer") ?? getHeaderValue(init, "http-referer"),
						userAgent: getHeaderValue(init, "User-Agent") ?? getHeaderValue(init, "user-agent"),
					})
				}
			}
		} catch {
			// ignore invalid URLs
		}

		return originalFetch.call(globalThis, input, init as RequestInit)
	} as typeof globalThis.fetch

	return () => {
		globalThis.fetch = originalFetch
	}
}

suite("OpenRouter provider", function () {
	setDefaultSuiteTimeout(this)

	let restoreFetch: (() => void) | undefined
	const requests: CapturedOpenRouterRequest[] = []

	setup(function () {
		const aimockUrl = process.env.AIMOCK_URL
		if (!aimockUrl && !OPENROUTER_API_KEY) {
			this.skip()
		}
	})

	suiteSetup(async () => {
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		const baseUrl = aimockUrl ? `${aimockUrl}/v1` : "https://openrouter.ai/api/v1"

		restoreFetch = installOpenRouterRequestCapture(requests, baseUrl)

		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
	})

	suiteTeardown(() => {
		restoreFetch?.()
		restoreFetch = undefined
	})

	test("Should identify as Zoo Code in outbound DEFAULT_HEADERS", async () => {
		requests.length = 0

		const api = globalThis.api
		const taskId = await api.startNewTask({
			configuration: { mode: "ask", autoApprovalEnabled: true },
			text: "openrouter-identity-smoke: what is 2+2? Reply with only the number.",
		})

		await waitUntilCompleted({ api, taskId })

		// Check all requests captured during the task — not just requests[0] — so that
		// background OpenRouter traffic before the task cannot mask a failure on the
		// actual task request.
		assert.ok(requests.length > 0, "OpenRouter provider should issue at least one outbound request")
		for (const captured of requests) {
			assert.strictEqual(captured.xTitle, "Zoo Code", "X-Title header should identify the extension as Zoo Code")
			assert.strictEqual(
				captured.httpReferer,
				"https://github.com/Zoo-Code-Org/Zoo-Code",
				"HTTP-Referer header should point to the Zoo Code repository",
			)
			assert.ok(
				captured.userAgent?.startsWith("ZooCode/"),
				`User-Agent should start with "ZooCode/" — got: ${captured.userAgent}`,
			)
		}
	})
})
