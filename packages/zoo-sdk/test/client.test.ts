import { describe, expect, test } from "bun:test"
import { ZooClient, type ZooTransport } from "../src/index.js"

function transport(): ZooTransport & { requests: any[] } {
	const requests: any[] = []
	return {
		requests,
		async request(input) {
			requests.push(input)
			if (input.path === "/permission")
				return { data: [{ id: "perm_1", sessionID: "ses_1", permission: "bash" }] }
			if (input.path === "/permission/perm_1/always-rules") return { data: true }
			if (input.path === "/session")
				return input.method === "POST" ? { data: { id: "ses_1" } } : { data: [{ id: "ses_1" }] }
			if (input.path === "/session/ses_1") return { data: { id: "ses_1" } }
			if (input.path === "/agent") {
				return { data: [{ name: "code", displayName: "Code", description: "Code mode", mode: "primary" }] }
			}
			if (input.path === "/config/warnings") return { data: [{ path: "zoo.jsonc", message: "Invalid config" }] }
			if (input.path === "/config" && input.method === "PATCH") return { data: input.body }
			if (input.path === "/config") return { data: { model: "anthropic/claude" } }
			if (input.path === "/config/providers") return { data: { default: "anthropic", providers: [] } }
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
		for await (const chunk of client.sendMessage("ses_1", "hi", { mode: "code" })) chunks.push(chunk)

		expect(chunks).toEqual([
			{ type: "text", sessionID: "ses_1", text: "hello" },
			{ type: "done", sessionID: "ses_1" },
		])
		expect(seen).toEqual(["hello"])
		expect(mock.requests.at(-1)).toMatchObject({
			method: "POST",
			path: "/session/ses_1/message",
			body: { agent: "code", message: "hi", parts: [{ type: "text", text: "hi" }] },
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

	test("lists permissions and saves always rules", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.listPermissions()).resolves.toEqual([
			{ id: "perm_1", sessionID: "ses_1", permission: "bash" },
		])
		await expect(
			client.savePermissionAlwaysRules("perm_1", { approvedAlways: ["npm test"], deniedAlways: ["rm -rf *"] }),
		).resolves.toBe(true)
		expect(mock.requests.slice(-2)).toEqual([
			{ path: "/permission" },
			{
				method: "POST",
				path: "/permission/perm_1/always-rules",
				body: { approvedAlways: ["npm test"], deniedAlways: ["rm -rf *"] },
			},
		])
	})

	test("lists portable core modes from agents", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.listModes()).resolves.toEqual([
			{ id: "code", name: "Code", description: "Code mode", primary: true },
		])
		expect(mock.requests.at(-1)).toEqual({ path: "/agent" })
	})

	test("reads portable core config and configured providers", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.getConfig()).resolves.toEqual({ model: "anthropic/claude" })
		await expect(client.getConfigProviders()).resolves.toEqual({ default: "anthropic", providers: [] })
		expect(mock.requests.slice(-2)).toEqual([{ path: "/config" }, { path: "/config/providers" }])
	})

	test("updates config and reads config warnings", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.updateConfig({ model: "openai/gpt-5" })).resolves.toEqual({ model: "openai/gpt-5" })
		await expect(client.getConfigWarnings()).resolves.toEqual([{ path: "zoo.jsonc", message: "Invalid config" }])
		expect(mock.requests.slice(-2)).toEqual([
			{ method: "PATCH", path: "/config", body: { model: "openai/gpt-5" } },
			{ path: "/config/warnings" },
		])
	})
})
