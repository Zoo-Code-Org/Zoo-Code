import { beforeEach, describe, expect, it, vi } from "vitest"

import { providerIdentifiers } from "@roo-code/types"

import { ZooRemoteControlClient } from "../ZooRemoteControlClient.js"

describe("ZooRemoteControlClient", () => {
	let fetchFn: ReturnType<typeof vi.fn>
	let getSessionToken: ReturnType<typeof vi.fn<() => string>>
	let getBaseUrl: ReturnType<typeof vi.fn<() => string>>
	let log: ReturnType<typeof vi.fn<(message: string) => void>>
	let client: ZooRemoteControlClient

	beforeEach(() => {
		fetchFn = vi.fn()
		getSessionToken = vi.fn(() => "zoo_ext_token")
		getBaseUrl = vi.fn(() => "https://www.zoocode.dev/")
		log = vi.fn()
		client = new ZooRemoteControlClient({
			getBaseUrl,
			getSessionToken,
			fetchFn: fetchFn as unknown as typeof fetch,
			log,
		})
	})

	it("returns 401 when no session token is present", async () => {
		getSessionToken.mockReturnValue("")
		const result = await client.postPresence({
			instanceId: "i1",
			apiProvider: providerIdentifiers.zooGateway,
			online: true,
		})
		expect(result).toEqual({ ok: false, status: 401 })
		expect(fetchFn).not.toHaveBeenCalled()
	})

	it("posts presence with bearer auth", async () => {
		fetchFn.mockResolvedValue({ ok: true, status: 200 })
		const presence = {
			instanceId: "i1",
			apiProvider: providerIdentifiers.zooGateway,
			online: true,
		}
		const result = await client.postPresence(presence)
		expect(result).toEqual({ ok: true, status: 200 })
		expect(fetchFn).toHaveBeenCalledWith(
			"https://www.zoocode.dev/api/extension/remote/presence",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer zoo_ext_token",
					"Content-Type": "application/json",
				}),
				body: JSON.stringify(presence),
			}),
		)
	})

	it("posts events", async () => {
		fetchFn.mockResolvedValue({ ok: true, status: 200 })
		const events = [{ type: "task_idle" as const, taskId: "t1", timestamp: 1 }]
		await client.postEvents("inst-1", events)
		expect(fetchFn).toHaveBeenCalledWith(
			"https://www.zoocode.dev/api/extension/remote/events",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ instanceId: "inst-1", events }),
			}),
		)
	})

	it("posts snapshots", async () => {
		fetchFn.mockResolvedValue({ ok: true, status: 200 })
		const snapshot = {
			instanceId: "inst-1",
			taskId: "t1",
			messages: [{ ts: 1, type: "say" as const, say: "text" as const, text: "hi" }],
			mode: "code",
		}
		await client.postSnapshot(snapshot)
		expect(fetchFn).toHaveBeenCalledWith(
			"https://www.zoocode.dev/api/extension/remote/snapshot",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify(snapshot),
			}),
		)
	})

	it("parses command list responses", async () => {
		fetchFn.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				commands: [{ commandId: "c1", type: "message", payload: { text: "hi" } }],
			}),
		})
		const result = await client.getCommands("inst-1")
		expect(result.ok).toBe(true)
		expect(result.body?.commands).toHaveLength(1)
		expect(fetchFn).toHaveBeenCalledWith(
			"https://www.zoocode.dev/api/extension/remote/commands?instanceId=inst-1",
			expect.objectContaining({ method: "GET" }),
		)
	})

	it("returns status 0 when getCommands JSON body is malformed", async () => {
		fetchFn.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError("Unexpected token")
			},
		})
		const result = await client.getCommands("inst-1")
		expect(result).toEqual({ ok: false, status: 0 })
		expect(log).toHaveBeenCalledWith(expect.stringContaining("Unexpected token"))
	})

	it("returns status 0 when getCommands body fails schema validation", async () => {
		fetchFn.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				commands: [{ commandId: "c1", type: "not_a_real_command" }],
			}),
		})
		const result = await client.getCommands("inst-1")
		expect(result).toEqual({ ok: false, status: 0 })
		expect(log).toHaveBeenCalled()
	})

	it("acks commands", async () => {
		fetchFn.mockResolvedValue({ ok: true, status: 200 })
		await client.ackCommand({ commandId: "c1", status: "acked" })
		expect(fetchFn).toHaveBeenCalledWith(
			"https://www.zoocode.dev/api/extension/remote/commands/c1/ack",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ commandId: "c1", status: "acked" }),
			}),
		)
	})

	it("returns non-ok status without throwing", async () => {
		fetchFn.mockResolvedValue({ ok: false, status: 404 })
		const result = await client.getCommands("inst-1")
		expect(result).toEqual({ ok: false, status: 404 })
		expect(log).not.toHaveBeenCalled()
	})

	it("logs non-404 failures", async () => {
		fetchFn.mockResolvedValue({ ok: false, status: 500 })
		await client.postEvents("inst-1", [])
		expect(log).toHaveBeenCalledWith(expect.stringContaining("500"))
	})

	it("returns status 0 when fetch throws", async () => {
		fetchFn.mockRejectedValue(new Error("network down"))
		const result = await client.postPresence({
			instanceId: "i1",
			apiProvider: providerIdentifiers.zooGateway,
			online: true,
		})
		expect(result).toEqual({ ok: false, status: 0 })
		expect(log).toHaveBeenCalledWith(expect.stringContaining("network down"))
	})
})
