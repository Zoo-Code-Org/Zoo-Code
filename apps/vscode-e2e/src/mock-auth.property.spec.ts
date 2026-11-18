import assert from "node:assert/strict"
import { test } from "node:test"

import { authenticatedMockFetch } from "./mock-auth"

const mockOrigin = "http://127.0.0.1:8123"
const credentialNames = ["authorization", "x-api-key", "x-goog-api-key", "api-key", "xi-api-key"]

function headerEntries(headers: Headers): [string, string][] {
	const entries: [string, string][] = []
	headers.forEach((value, name) => entries.push([name, value]))
	return entries
}

async function captureRequest(input: RequestInfo | URL, init?: RequestInit) {
	const calls: { input: RequestInfo | URL; init: RequestInit | undefined; headers: Headers }[] = []
	const sink: typeof fetch = async (actualInput, actualInit) => {
		calls.push({
			input: actualInput,
			init: actualInit,
			headers: new Headers(
				actualInit?.headers ?? (actualInput instanceof Request ? actualInput.headers : undefined),
			),
		})
		return new Response()
	}
	await authenticatedMockFetch(sink, mockOrigin, "per-run-key")(input, init)
	assert.equal(calls.length, 1)
	const call = calls[0]!
	assert.equal(call.input, input)
	return call
}

// Exhaust the credential subsets in MockAuthentication.tla for each fetch input form.
void test("mock requests replace all credential subsets and preserve other headers", async () => {
	for (let mask = 0; mask < 2 ** credentialNames.length; mask++) {
		const headers = new Headers({ "x-preserved": "yes" })
		credentialNames.forEach((name, index) => {
			if (mask & (1 << index)) headers.set(name, "original")
		})
		const url = `${mockOrigin}/__aimock/fixtures`
		for (const input of [url, new URL(url), new Request(url, { headers })]) {
			const call = await captureRequest(input, input instanceof Request ? undefined : { headers })
			assert.deepEqual(headerEntries(call.headers), [
				["authorization", "Bearer per-run-key"],
				["x-preserved", "yes"],
			])
		}
	}
})

void test("other origins keep the original request options and credentials", async () => {
	for (const origin of ["http://127.0.0.1:8124", "http://localhost:8123", "https://127.0.0.1:8123"]) {
		const headers = new Headers(credentialNames.map((name): [string, string] => [name, "original"]))
		const url = `${origin}/__aimock/fixtures`
		for (const input of [url, new URL(url), new Request(url, { headers })]) {
			const init: RequestInit = { redirect: "manual", ...(input instanceof Request ? {} : { headers }) }
			const call = await captureRequest(input, init)
			assert.equal(call.init, init)
			assert.deepEqual(headerEntries(call.headers), headerEntries(headers))
		}
	}
})

void test("mock requests reject redirects regardless of the requested policy", async () => {
	for (const redirect of [undefined, "follow", "manual", "error"] as const) {
		const call = await captureRequest(mockOrigin, { redirect })
		assert.equal(call.init?.redirect, "error")
	}
})

void test("init headers replace Request headers before mock authentication is applied", async () => {
	const input = new Request(mockOrigin, {
		headers: { "x-source": "request", "x-request-only": "discard", authorization: "Bearer request" },
	})
	for (const headers of [new Headers(), new Headers({ "x-source": "init", "x-api-key": "original" })]) {
		const call = await captureRequest(input, { headers })
		assert.equal(call.headers.get("authorization"), "Bearer per-run-key")
		assert.equal(call.headers.get("x-source"), headers.get("x-source"))
		assert.equal(call.headers.get("x-request-only"), null)
		assert.equal(call.headers.get("x-api-key"), null)
	}
})
