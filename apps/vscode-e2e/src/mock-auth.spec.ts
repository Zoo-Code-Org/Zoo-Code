import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { test } from "node:test"
import { LLMock } from "@copilotkit/aimock"

import { authenticatedMockFetch } from "./mock-auth"

void test("mock authentication rejects fixture tampering and permits replay", async () => {
	const key = randomBytes(32).toString("hex")
	const mock = new LLMock({ port: 0, auth: { apiKeys: [key] } })
	mock.addFixture({ match: { userMessage: "smoke" }, response: { content: "trusted" } })
	await mock.start()
	try {
		for (const path of ["/__aimock/fixtures", "/__aimock/reset"]) {
			for (const credential of [undefined, "mock-key"]) {
				const response = await fetch(`${mock.url}${path}`, {
					method: "POST",
					headers: credential ? { authorization: `Bearer ${credential}` } : {},
					body: JSON.stringify({ fixtures: [] }),
				})
				assert.equal(response.status, 401)
			}
		}
		const client = authenticatedMockFetch(fetch, mock.url, key)
		assert.equal(
			(
				await client(`${mock.url}/__aimock/fixtures`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						fixtures: [{ match: { userMessage: "other" }, response: { content: "safe" } }],
					}),
				})
			).status,
			200,
		)
		const providerHeaders: Record<string, string>[] = [
			{},
			{ "x-api-key": "original" },
			{ "x-goog-api-key": "original" },
		]
		for (const headers of providerHeaders) {
			const response = await client(
				new Request(`${mock.url}/v1/chat/completions`, {
					method: "POST",
					headers: { ...headers, "content-type": "application/json" },
					body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "smoke" }] }),
				}),
			)
			assert.equal(response.status, 200)
			assert.equal((await response.json()).choices[0].message.content, "trusted")
		}
		assert.equal((await client(`${mock.url}/__aimock/fixtures`)).status, 200)
		assert.equal((await client(`${mock.url}/__aimock/reset`, { method: "POST" })).status, 200)
	} finally {
		await mock.stop()
	}
})

void test("recording uses the upstream key and never forwards the mock credential", async () => {
	let authorization: string | undefined
	const upstream = createServer((req, res) => {
		authorization = req.headers.authorization
		res.setHeader("content-type", "application/json")
		res.end(
			JSON.stringify({
				choices: [{ message: { role: "assistant", content: "recorded" }, finish_reason: "stop" }],
			}),
		)
	})
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
	const address = upstream.address()
	assert.ok(address && typeof address !== "string")
	const upstreamUrl = `http://127.0.0.1:${address.port}`
	const key = randomBytes(32).toString("hex")
	const mock = new LLMock({
		port: 0,
		auth: { apiKeys: [key] },
		record: {
			providers: { openai: upstreamUrl },
			providerKeys: { openai: "synthetic-upstream-key" },
			proxyOnly: true,
		},
	})
	try {
		await mock.start()
		const client = authenticatedMockFetch(fetch, mock.url, key)
		const response = await client(`${mock.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer original" },
			body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "record" }] }),
		})
		assert.equal(response.status, 200)
		await response.text()
		assert.equal(authorization, "Bearer synthetic-upstream-key")
		await client(upstreamUrl, { headers: { authorization: "Bearer unrelated" } })
		assert.equal(authorization, "Bearer unrelated")
	} finally {
		await mock.stop()
		await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())))
	}
})
