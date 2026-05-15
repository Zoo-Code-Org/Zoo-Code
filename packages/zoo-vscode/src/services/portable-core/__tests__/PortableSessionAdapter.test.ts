import { PortableSessionAdapter } from "../PortableSessionAdapter"

describe("PortableSessionAdapter", () => {
	const createClient = () => ({
		createSession: vitest.fn().mockResolvedValue({ id: "session-1", title: "Task" }),
		listSessions: vitest.fn().mockResolvedValue([{ id: "session-1" }]),
		getSession: vitest.fn().mockResolvedValue({ id: "session-1" }),
		sendMessage: vitest.fn().mockImplementation(async function* () {
			yield { type: "text", sessionID: "session-1", text: "hello" }
		}),
		abortSession: vitest.fn().mockResolvedValue(undefined),
		subscribeEvents: vitest.fn().mockImplementation(async function* () {
			yield { type: "permission.asked", properties: { id: "perm_1", sessionID: "session-1", permission: "bash" } }
		}),
		replyPermission: vitest.fn().mockResolvedValue(undefined),
		listModes: vitest.fn().mockResolvedValue([{ id: "code", name: "Code" }]),
		getConfig: vitest.fn().mockResolvedValue({ model: "anthropic/claude" }),
		getConfigProviders: vitest.fn().mockResolvedValue({ default: { providerID: "anthropic" }, providers: [] }),
	})

	it("maps create/list/get session calls to the Zoo SDK client", async () => {
		const client = createClient()
		const adapter = new PortableSessionAdapter(client as any)

		await expect(adapter.createSession({ title: "Task" })).resolves.toEqual({ id: "session-1", title: "Task" })
		await expect(adapter.listSessions({ directory: "/workspace" })).resolves.toEqual([{ id: "session-1" }])
		await expect(adapter.getSession("session-1")).resolves.toEqual({ id: "session-1" })

		expect(client.createSession).toHaveBeenCalledWith({ title: "Task" })
		expect(client.listSessions).toHaveBeenCalledWith({ directory: "/workspace" })
		expect(client.getSession).toHaveBeenCalledWith("session-1")
	})

	it("maps send and abort calls to the Zoo SDK client", async () => {
		const client = createClient()
		const adapter = new PortableSessionAdapter(client as any)

		const chunks: unknown[] = []
		for await (const chunk of adapter.sendMessage("session-1", "hello", { mode: "code" })) {
			chunks.push(chunk)
		}
		await adapter.abortSession("session-1")

		expect(chunks).toEqual([{ type: "text", sessionID: "session-1", text: "hello" }])
		expect(client.sendMessage).toHaveBeenCalledWith("session-1", "hello", { mode: "code" })
		expect(client.abortSession).toHaveBeenCalledWith("session-1")
	})

	it("maps event subscription and permission replies to the Zoo SDK client", async () => {
		const client = createClient()
		const adapter = new PortableSessionAdapter(client as any)
		const events = []

		for await (const event of adapter.subscribeEvents()) events.push(event)
		await adapter.replyPermission("perm_1", { reply: "once" })

		expect(events).toEqual([
			{ type: "permission.asked", properties: { id: "perm_1", sessionID: "session-1", permission: "bash" } },
		])
		expect(client.subscribeEvents).toHaveBeenCalledTimes(1)
		expect(client.replyPermission).toHaveBeenCalledWith("perm_1", { reply: "once" })
	})

	it("maps mode listing to the Zoo SDK client", async () => {
		const client = createClient()
		const adapter = new PortableSessionAdapter(client as any)

		await expect(adapter.listModes()).resolves.toEqual([{ id: "code", name: "Code" }])
		expect(client.listModes).toHaveBeenCalledTimes(1)
	})

	it("maps config reads to the Zoo SDK client", async () => {
		const client = createClient()
		const adapter = new PortableSessionAdapter(client as any)

		await expect(adapter.getConfig()).resolves.toEqual({ model: "anthropic/claude" })
		await expect(adapter.getConfigProviders()).resolves.toEqual({
			default: { providerID: "anthropic" },
			providers: [],
		})
		expect(client.getConfig).toHaveBeenCalledTimes(1)
		expect(client.getConfigProviders).toHaveBeenCalledTimes(1)
	})

	it("rejects malformed modes and provider config results", async () => {
		const client = createClient()
		const adapter = new PortableSessionAdapter(client as any)

		client.listModes.mockResolvedValueOnce([{ id: "code", name: "Code" }, { name: "Missing id" }])
		await expect(adapter.listModes()).rejects.toThrow("listModes[1] returned a mode without a string id")

		client.getConfigProviders.mockResolvedValueOnce({ providers: [{ name: "Missing id" }] })
		await expect(adapter.getConfigProviders()).rejects.toThrow(
			"getConfigProviders.providers[0] returned a provider without a string id",
		)

		client.getConfigProviders.mockResolvedValueOnce({ default: "anthropic", providers: [] })
		await expect(adapter.getConfigProviders()).rejects.toThrow(
			"getConfigProviders returned an invalid default provider config",
		)
	})

	it("rejects malformed session responses", async () => {
		const client = createClient()
		const adapter = new PortableSessionAdapter(client as any)

		client.createSession.mockResolvedValueOnce({ title: "missing id" })
		await expect(adapter.createSession()).rejects.toThrow("createSession returned a session without a string id")

		client.getSession.mockResolvedValueOnce({ id: 123 })
		await expect(adapter.getSession("bad-session")).rejects.toThrow(
			"getSession returned a session without a string id",
		)

		client.listSessions.mockResolvedValueOnce([{ id: "ok" }, { id: undefined }])
		await expect(adapter.listSessions()).rejects.toThrow("listSessions[1] returned a session without a string id")
	})

	it("rejects malformed streamed message chunks", async () => {
		const client = createClient()
		client.sendMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: "ok" }
			yield { text: "missing type" }
		})
		const adapter = new PortableSessionAdapter(client as any)
		const chunks: unknown[] = []

		await expect(async () => {
			for await (const chunk of adapter.sendMessage("session-1", "hello")) {
				chunks.push(chunk)
			}
		}).rejects.toThrow("sendMessage returned a chunk without a string type")

		expect(chunks).toEqual([{ type: "text", text: "ok" }])
	})

	it("preserves extra fields on valid sessions and chunks", async () => {
		const client = createClient()
		client.createSession.mockResolvedValueOnce({ id: "session-extra", title: "Task", extra: { value: true } })
		client.sendMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: "ok", extra: 1 }
		})
		const adapter = new PortableSessionAdapter(client as any)

		await expect(adapter.createSession()).resolves.toEqual({
			id: "session-extra",
			title: "Task",
			extra: { value: true },
		})

		const chunks = []
		for await (const chunk of adapter.sendMessage("session-extra", "hello")) {
			chunks.push(chunk)
		}
		expect(chunks).toEqual([{ type: "text", text: "ok", extra: 1 }])
	})
})
