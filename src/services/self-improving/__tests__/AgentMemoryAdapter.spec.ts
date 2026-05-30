import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AgentMemoryAdapter } from "../AgentMemoryAdapter"

describe("AgentMemoryAdapter", () => {
	const logger = { appendLine: vi.fn() }
	const adapters: AgentMemoryAdapter[] = []

	beforeEach(() => {
		logger.appendLine.mockReset()
	})

	afterEach(async () => {
		await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()))
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	function createAdapter(): AgentMemoryAdapter {
		const adapter = new AgentMemoryAdapter(logger)
		adapters.push(adapter)
		return adapter
	}

	it("should report unavailable when server is not running", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")))

		const adapter = createAdapter()
		await adapter.initialize()

		const stats = await adapter.getStats()
		expect(stats.backend).toContain("unavailable")
		expect(stats.entryCount).toBe(0)
	})

	it("should return null from store when unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")))

		const adapter = createAdapter()
		await adapter.initialize()

		const result = await adapter.store({
			content: "test memory",
			source: "learning",
		})

		expect(result).toBeNull()
	})

	it("should return empty array from search when unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")))

		const adapter = createAdapter()
		await adapter.initialize()

		const results = await adapter.search("test")
		expect(results).toEqual([])
	})

	it("should return empty array from recall when unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")))

		const adapter = createAdapter()
		await adapter.initialize()

		const results = await adapter.recall()
		expect(results).toEqual([])
	})

	it("should ignore empty forgetByContent queries", async () => {
		const fetchSpy = vi.fn()
		vi.stubGlobal("fetch", fetchSpy)

		const adapter = createAdapter()

		await expect(adapter.forgetByContent("   ")).resolves.toBe(0)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("should trim forgetByContent queries before searching", async () => {
		const fetchSpy = vi.fn(async (input: string, init?: RequestInit) => {
			if (input.endsWith("/agentmemory/livez")) {
				return { ok: true } as Response
			}

			if (input.endsWith("/agentmemory/search")) {
				const body = JSON.parse(String(init?.body)) as { query: string }
				expect(body.query).toBe("Foo")
				return {
					ok: true,
					json: async () => ({
						results: [
							{
								observation: { id: "memory-1", content: "foo memory" },
								score: 1,
							},
						],
					}),
				} as Response
			}

			if (input.endsWith("/agentmemory/forget")) {
				return { ok: true, json: async () => ({ success: true }) } as Response
			}

			throw new Error(`Unexpected fetch call: ${input}`)
		})
		vi.stubGlobal("fetch", fetchSpy)

		const adapter = createAdapter()
		await adapter.initialize()

		await expect(adapter.forgetByContent("  Foo  ")).resolves.toBe(1)
	})

	it("should clean up health check interval on dispose", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")))

		const adapter = createAdapter()
		await adapter.initialize()
		await adapter.dispose()

		const result = await adapter.store({
			content: "test",
			source: "learning",
		})
		expect(result).toBeNull()
	})

	it("should have correct backend type", () => {
		const adapter = createAdapter()
		expect(adapter.backendType).toBe("agentmemory")
	})
})
