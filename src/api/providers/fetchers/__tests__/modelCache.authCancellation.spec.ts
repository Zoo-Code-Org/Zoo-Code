import { getEventListeners } from "events"
import axios from "axios"
import { providerIdentifiers } from "@roo-code/types"

import { ModelRequestRegistry } from "../../../../core/webview/ModelRequestRegistry"
import { getModels, refreshModels } from "../modelCache"

vi.mock("../../../../services/zoo-code-auth", () => ({
	getZooCodeBaseUrl: () => "https://example.test",
	resolveZooGatewaySessionToken: (token?: string) => token,
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureEvent: vi.fn(), isTelemetryEnabled: () => false } },
}))

// Keep the registry, cache dispatch, and auth-scoped fetchers real; only HTTP is replaced.
describe.each([getModels, refreshModels])("auth-scoped cancellation via %s", (loadModels) => {
	describe.each([providerIdentifiers.zooGateway, providerIdentifiers.kimiCode])("%s", (provider) => {
		let registry: ModelRequestRegistry
		let signals: AbortSignal[]
		let events: string[]

		beforeEach(() => {
			vi.useFakeTimers()
			registry = new ModelRequestRegistry()
			signals = []
			events = []
			vi.spyOn(console, "error").mockImplementation(() => {})
			const pendingRequest = (signal?: AbortSignal | null) => {
				expect(signal).toBeDefined()
				if (!signal) throw new Error("HTTP request has no cancellation signal")
				signals.push(signal)
				const index = signals.length
				events.push(`start:${index}`)
				return new Promise<never>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							events.push(`abort:${index}`)
							reject(signal.reason)
						},
						{ once: true },
					)
				})
			}
			vi.spyOn(axios, "get").mockImplementation((_url, config) => {
				expect(config?.timeout).toBe(15_000)
				return pendingRequest(config?.signal instanceof AbortSignal ? config.signal : undefined)
			})
			vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => pendingRequest(init?.signal))
		})

		afterEach(() => {
			registry.dispose()
			vi.restoreAllMocks()
			vi.useRealTimers()
		})

		it.each(["cancel", "replace"])("aborts HTTP before restarting after %s", async (action) => {
			const ownerSignals: AbortSignal[] = []
			const discover = async (signal: AbortSignal) => {
				ownerSignals.push(signal)
				await loadModels({ provider, apiKey: "synthetic-token", signal })
			}
			const first = registry.run("router", discover)
			expect(events).toEqual(["start:1"])
			if (action === "cancel") registry.cancel("router")
			const second = registry.run("router", discover)
			expect(events).toEqual(["start:1", "abort:1", "start:2"])
			expect(signals[0].aborted).toBe(true)
			expect(signals[1].aborted).toBe(false)
			await first
			registry.cancel("router")
			await second
			expect(events).toEqual(["start:1", "abort:1", "start:2", "abort:2"])
			for (const signal of ownerSignals) expect(getEventListeners(signal, "abort")).toHaveLength(0)
			expect(vi.getTimerCount()).toBe(0)
		})

		it("does not start HTTP for a pre-aborted caller", async () => {
			const controller = new AbortController()
			controller.abort()
			const result = loadModels({ provider, apiKey: "synthetic-token", signal: controller.signal })
			if (loadModels === getModels) await expect(result).rejects.toMatchObject({ name: "AbortError" })
			else await expect(result).resolves.toEqual({})
			expect(axios.get).not.toHaveBeenCalled()
			expect(fetch).not.toHaveBeenCalled()
			expect(vi.getTimerCount()).toBe(0)
		})
	})
})
