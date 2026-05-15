import { describe, expect, test } from "bun:test"
import { ZooClient, type ZooTransport } from "../src/index.js"

function transport(): ZooTransport & { requests: any[] } {
	const requests: any[] = []
	return {
		requests,
		async request(input) {
			requests.push(input)
			if (input.path === "/session")
				return input.method === "POST" ? { data: { id: "ses_1" } } : { data: [{ id: "ses_1" }] }
			if (input.path === "/session/ses_1") return { data: { id: "ses_1" } }
			return { data: undefined }
		},
		async *stream(input) {
			requests.push(input)
			if (input.path === "/event") {
				yield {
					type: "permission.asked",
					properties: { id: "perm_1", sessionID: "ses_1", permission: "bash" },
				}
				return
			}
			yield { type: "text", sessionID: "ses_1", text: "hello" }
			yield { type: "done", sessionID: "ses_1" }
		},
	}
}

describe("ZooClient", () => {
	test("constructs session requests", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		expect(await client.createSession({ title: "Smoke" })).toEqual({ id: "ses_1" })
		expect(await client.listSessions()).toEqual([{ id: "ses_1" }])
		expect(await client.getSession("ses_1")).toEqual({ id: "ses_1" })
		await client.abortSession("ses_1")

		expect(mock.requests.map((item) => [item.method ?? "GET", item.path])).toEqual([
			["POST", "/session"],
			["GET", "/session"],
			["GET", "/session/ses_1"],
			["POST", "/session/ses_1/abort"],
		])
	})

	test("streams message chunks and emits subscribed events", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })
		const seen: string[] = []
		client.on("text", (event) => seen.push(String(event.text)))

		const chunks = []
		for await (const chunk of client.sendMessage("ses_1", "hi")) chunks.push(chunk)

		expect(chunks).toEqual([
			{ type: "text", sessionID: "ses_1", text: "hello" },
			{ type: "done", sessionID: "ses_1" },
		])
		expect(seen).toEqual(["hello"])
		expect(mock.requests.at(-1)).toMatchObject({
			method: "POST",
			path: "/session/ses_1/message",
			body: { message: "hi", parts: [{ type: "text", text: "hi" }] },
		})
	})

	test("subscribes to server events and replies to permission requests", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })
		const events = []

		for await (const event of client.subscribeEvents()) events.push(event)
		await client.replyPermission("perm_1", { reply: "reject", message: "No thanks" })

		expect(events).toEqual([
			{
				type: "permission.asked",
				properties: { id: "perm_1", sessionID: "ses_1", permission: "bash" },
			},
		])
		expect(mock.requests.at(-2)).toMatchObject({ path: "/event" })
		expect(mock.requests.at(-1)).toEqual({
			method: "POST",
			path: "/permission/perm_1/reply",
			body: { reply: "reject", message: "No thanks" },
		})
	})
})
