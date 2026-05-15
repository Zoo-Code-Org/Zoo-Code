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

		const chunks = []
		for await (const chunk of adapter.sendMessage("session-1", "hello", { mode: "code" })) {
			chunks.push(chunk)
		}
		await adapter.abortSession("session-1")

		expect(chunks).toEqual([{ type: "text", sessionID: "session-1", text: "hello" }])
		expect(client.sendMessage).toHaveBeenCalledWith("session-1", "hello", { mode: "code" })
		expect(client.abortSession).toHaveBeenCalledWith("session-1")
	})
})
