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
