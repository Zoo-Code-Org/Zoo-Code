// npx vitest run api/providers/__tests__/mimo-redirect.spec.ts

// Deliberately does NOT mock "openai": this suite proves the redirect policy the
// real SDK client actually sends, which a mocked constructor cannot show.
import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiHandlerOptions } from "../../../shared/api"
import { MimoHandler } from "../mimo"
import { collectStream } from "../../../test-utils/stream"

const ALLOWED_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/v1"
const REDIRECT_TARGET = "https://attacker.example/collect"

const options = (): ApiHandlerOptions => ({
	mimoApiKey: "test-api-key",
	apiModelId: "mimo-v2.6-pro",
	mimoBaseUrl: ALLOWED_BASE_URL,
})

const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

/**
 * Stands in for the transport, emulating the fetch redirect contract rather than
 * just recording the init: a 3xx is refused when the init says redirect:"error",
 * and otherwise replayed against the Location target with the same method,
 * headers, and body -- exactly what undici's default redirect:"follow" does. That
 * is what makes this a behavioral test: the assertion below fails on the old
 * code because the request really does reach the attacker URL.
 */
const redirectingFetch = () => {
	const calls: { url: string; init: RequestInit }[] = []

	const redirect = (status: number, location: string) =>
		new Response(null, { status, statusText: "Redirect", headers: { location } })

	const fetchDouble = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
		calls.push({ url, init: init ?? {} })

		const response = url.startsWith(ALLOWED_BASE_URL)
			? redirect(307, REDIRECT_TARGET)
			: new Response('data: {"choices":[{"delta":{"content":"leaked"},"index":0}]}\n\ndata: [DONE]\n\n', {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})

		const location = response.headers.get("location")
		if (!location) {
			return response
		}

		if (init?.redirect === "error") {
			throw new TypeError("fetch failed: unexpected redirect")
		}

		if (init?.redirect === "manual") {
			return response
		}

		// Default policy: follow. Re-issue the same request against the target.
		return fetchDouble(new URL(location, url).toString(), init)
	}

	return { fetchDouble, calls }
}

describe("MimoHandler inference client redirect policy", () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it("pins redirect:'error' on the SDK client it builds", () => {
		const handler = new MimoHandler(options())

		// The SDK spreads client.fetchOptions into every request init, so this is
		// the value the transport receives. Asserted directly as well as through
		// the request below, so a change to the SDK's plumbing fails here first.
		expect(handler["client"].fetchOptions).toEqual({ redirect: "error" })
	})

	// Regression: the SDK's default fetch follows 3xx, so an allowlisted Xiaomi
	// origin answering with a redirect replayed the POST body (system prompt,
	// conversation, tool output) to an origin the allowlist never vetted. Before
	// the fix the 307 was followed and the request resolved against the attacker
	// URL; with the policy pinned, the request must reject instead.
	it("rejects a 307 from an allowlisted origin instead of replaying the request cross-origin", async () => {
		const { fetchDouble, calls } = redirectingFetch()
		globalThis.fetch = fetchDouble as unknown as typeof fetch

		const handler = new MimoHandler(options())

		await expect(collectStream(handler.createMessage("System prompt", messages))).rejects.toThrow()

		// The transport was told not to follow, and nothing was ever sent to the
		// redirect target.
		expect(calls.length).toBeGreaterThan(0)
		for (const call of calls) {
			expect(call.init.redirect).toBe("error")
			expect(call.url.startsWith(ALLOWED_BASE_URL)).toBe(true)
		}
		expect(calls.some((call) => call.url.startsWith(REDIRECT_TARGET))).toBe(false)
	})
})
