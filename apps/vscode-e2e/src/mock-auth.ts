// Keep the per-run credential on requests to this mock only, including SDKs
// that use different credential headers (or no credentials, like LM Studio).
export function authenticatedMockFetch(fetch: typeof globalThis.fetch, mockUrl: string, apiKey: string): typeof fetch {
	const origin = new URL(mockUrl).origin
	return (input, init) => {
		const url = input instanceof Request ? input.url : input.toString()
		if (new URL(url).origin !== origin) {
			return fetch(input, init)
		}

		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
		// aimock rejects conflicting credential headers, and recording uses the
		// parent's providerKeys rather than any of these inbound credentials.
		for (const name of ["authorization", "x-api-key", "x-goog-api-key", "api-key", "xi-api-key"]) {
			headers.delete(name)
		}
		headers.set("authorization", `Bearer ${apiKey}`)
		return fetch(input, { ...init, headers, redirect: "error" })
	}
}
