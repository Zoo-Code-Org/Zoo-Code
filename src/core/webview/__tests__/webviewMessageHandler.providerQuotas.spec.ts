// npx vitest core/webview/__tests__/webviewMessageHandler.providerQuotas.spec.ts

import { beforeEach, describe, expect, it, vi } from "vitest"

import { providerIdentifiers } from "@roo-code/types"

const quotas = vi.hoisted(() => ({
	getProviderQuotas: vi.fn(),
}))

// Keep the real `loadProfiles` (it is the code under test alongside the handler) and stub only the network part.
vi.mock("../../../services/language-models/providerQuotas", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../services/language-models/providerQuotas")>()),
	getProviderQuotas: quotas.getProviderQuotas,
}))

import { abortProviderQuotaRequests, webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"

const SECRET = "sk-super-secret"

const makeProvider = (overrides: Record<string, unknown> = {}) =>
	({
		postMessageToWebview: vi.fn(),
		log: vi.fn(),
		contextProxy: { getValue: vi.fn((key: string) => (key === "currentApiConfigName" ? "default" : undefined)) },
		providerSettingsManager: {
			listConfig: vi.fn(async () => [{ id: "a" }, { id: "b" }]),
			getProfile: vi.fn(async ({ id }: { id: string }) => ({
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: SECRET,
				id,
			})),
		},
		...overrides,
	}) as unknown as ClineProvider & { postMessageToWebview: ReturnType<typeof vi.fn> }

describe("webviewMessageHandler – requestProviderQuotas", () => {
	beforeEach(() => {
		// mockReset clears an earlier test's mockImplementation too, so a pending-promise stub cannot leak.
		quotas.getProviderQuotas.mockReset()
		quotas.getProviderQuotas.mockResolvedValue([
			{
				providerId: providerIdentifiers.openrouter,
				ok: true,
				fetchedAt: 1,
				windows: [{ id: "key_limit", valueLabel: "$5.00 / $10.00 used", usedPercent: 50 }],
			},
		])
	})

	it("puts the active profile first, so the quota row is the account the requests use", async () => {
		const provider = makeProvider({
			contextProxy: { getValue: vi.fn(() => "personal") },
			providerSettingsManager: {
				listConfig: vi.fn(async () => [
					{ id: "a", name: "work" },
					{ id: "b", name: "personal" },
				]),
				getProfile: vi.fn(async ({ id }: { id: string }) => ({
					apiProvider: providerIdentifiers.openrouter,
					openRouterApiKey: `key-${id}`,
				})),
			},
		})
		await webviewMessageHandler(provider, { type: "requestProviderQuotas" })

		expect(
			quotas.getProviderQuotas.mock.calls[0][0].map((p: { openRouterApiKey: string }) => p.openRouterApiKey),
		).toEqual(["key-b", "key-a"])
	})

	it("passes the active profile's id on, so its own credentials are the ones queried", async () => {
		const provider = makeProvider({
			contextProxy: { getValue: vi.fn(() => "personal") },
			providerSettingsManager: {
				listConfig: vi.fn(async () => [
					{ id: "a", name: "work" },
					{ id: "b", name: "personal" },
				]),
				getProfile: vi.fn(async ({ id }: { id: string }) => ({
					apiProvider: providerIdentifiers.openrouter,
					id,
				})),
			},
		})
		await webviewMessageHandler(provider, { type: "requestProviderQuotas" })

		expect(quotas.getProviderQuotas).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({ activeProfileId: "b" }),
		)
	})

	it("reports a failure, not an empty list, when no saved profile can be read", async () => {
		const provider = makeProvider({
			providerSettingsManager: {
				listConfig: vi.fn(async () => [{ id: "a" }]),
				getProfile: vi.fn(async () => {
					throw new Error("corrupt secret storage")
				}),
			},
		})
		await webviewMessageHandler(provider, { type: "requestProviderQuotas" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "providerQuotas", providerQuotas: [], providerQuotasFailed: true }),
		)
	})

	describe("when the provider is disposed", () => {
		it("aborts the requests in flight, and posts nothing for them", async () => {
			let signal: AbortSignal | undefined
			quotas.getProviderQuotas.mockImplementation(
				(_profiles: unknown, options: { signal: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						signal = options.signal
						options.signal.addEventListener("abort", () =>
							reject(new DOMException("Aborted", "AbortError")),
						)
					}),
			)
			const provider = makeProvider()
			const handling = webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "q1" })
			await vi.waitFor(() => expect(signal).toBeDefined())

			abortProviderQuotaRequests(provider)
			await handling

			expect(signal?.aborted).toBe(true)
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("does nothing for a provider with no requests in flight", () => {
			expect(() => abortProviderQuotaRequests(makeProvider())).not.toThrow()
		})
	})

	it("loads every saved profile and posts the formatted quotas back", async () => {
		const provider = makeProvider()
		await webviewMessageHandler(provider, { type: "requestProviderQuotas" })

		expect(provider.providerSettingsManager.getProfile).toHaveBeenCalledTimes(2)
		expect(quotas.getProviderQuotas.mock.calls[0][0]).toHaveLength(2)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "providerQuotas",
			providerQuotas: expect.arrayContaining([
				expect.objectContaining({ providerId: providerIdentifiers.openrouter }),
			]),
			providerQuotasFailed: false,
			requestId: undefined,
		})
	})

	it("does not force a refresh by default, and forces when the user presses refresh", async () => {
		const provider = makeProvider()
		await webviewMessageHandler(provider, { type: "requestProviderQuotas" })
		expect(quotas.getProviderQuotas).toHaveBeenLastCalledWith(expect.any(Array), {
			force: false,
			signal: expect.any(AbortSignal),
		})

		await webviewMessageHandler(provider, { type: "requestProviderQuotas", bool: true })
		expect(quotas.getProviderQuotas).toHaveBeenLastCalledWith(expect.any(Array), {
			force: true,
			signal: expect.any(AbortSignal),
		})
	})

	it("passes API keys to the host service but never posts them to the webview", async () => {
		const provider = makeProvider()
		await webviewMessageHandler(provider, { type: "requestProviderQuotas" })

		// The service needs the key...
		expect(JSON.stringify(quotas.getProviderQuotas.mock.calls[0][0])).toContain(SECRET)
		// ...but nothing posted to the webview may contain it.
		expect(JSON.stringify(provider.postMessageToWebview.mock.calls)).not.toContain(SECRET)
	})

	it("still answers when one profile cannot be loaded", async () => {
		const provider = makeProvider()
		provider.providerSettingsManager.getProfile = vi.fn(async ({ id }: { id: string }) => {
			if (id === "a") throw new Error("corrupt secret storage")
			return { apiProvider: providerIdentifiers.openrouter, openRouterApiKey: SECRET } as never
		}) as never

		await webviewMessageHandler(provider, { type: "requestProviderQuotas" })
		expect(quotas.getProviderQuotas.mock.calls[0][0]).toHaveLength(1)
		expect(provider.postMessageToWebview).toHaveBeenCalled()
	})

	it("still answers, and logs, when the profile list cannot be read", async () => {
		const log = vi.fn()
		const provider = makeProvider({ log })
		provider.providerSettingsManager.listConfig = vi.fn(async () => {
			throw new Error("secret storage unavailable")
		}) as never

		await webviewMessageHandler(provider, { type: "requestProviderQuotas" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "providerQuotas",
			providerQuotas: [],
			providerQuotasFailed: true,
			requestId: undefined,
		})
		expect(log).toHaveBeenCalledWith(expect.stringContaining("secret storage unavailable"))
	})

	it("still answers when the quota service throws something that is not an Error", async () => {
		const log = vi.fn()
		const provider = makeProvider({ log })
		quotas.getProviderQuotas.mockRejectedValue("nope")

		await webviewMessageHandler(provider, { type: "requestProviderQuotas" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "providerQuotas",
			providerQuotas: [],
			providerQuotasFailed: true,
			requestId: undefined,
		})
		expect(log).toHaveBeenCalledWith(expect.stringContaining("Failed to load provider limits"))
	})

	it("answers with an empty list when there are no profiles", async () => {
		quotas.getProviderQuotas.mockResolvedValue([])
		const provider = makeProvider()
		provider.providerSettingsManager.listConfig = vi.fn(async () => []) as never

		await webviewMessageHandler(provider, { type: "requestProviderQuotas" })
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "providerQuotas",
			providerQuotas: [],
			providerQuotasFailed: false,
			requestId: undefined,
		})
	})

	describe("request lifecycle", () => {
		it("echoes the request id on the answer", async () => {
			const provider = makeProvider()
			await webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "req-1" })
			expect(provider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ type: "providerQuotas", requestId: "req-1" }),
			)
		})

		it("passes an abort signal to the quota service", async () => {
			const provider = makeProvider()
			await webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "req-2" })
			expect(quotas.getProviderQuotas).toHaveBeenLastCalledWith(expect.any(Array), {
				force: false,
				signal: expect.any(AbortSignal),
			})
		})

		it("aborts the work and posts nothing when the request is cancelled while it is running", async () => {
			let signal: AbortSignal | undefined
			let finish: (value: never[]) => void = () => {}
			quotas.getProviderQuotas.mockImplementation((_profiles, options: { signal: AbortSignal }) => {
				signal = options.signal
				return new Promise((resolve) => (finish = resolve))
			})
			const provider = makeProvider()

			const running = webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "req-3" })
			await vi.waitFor(() => expect(signal).toBeDefined())
			await webviewMessageHandler(provider, { type: "cancelProviderQuotas", requestId: "req-3" })

			expect(signal!.aborted).toBe(true)
			finish([])
			await running
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("does not post when the request was cancelled before the profiles finished loading", async () => {
			const provider = makeProvider()
			let release: (entries: { id: string }[]) => void = () => {}
			provider.providerSettingsManager.listConfig = vi.fn(
				() => new Promise((resolve) => (release = resolve)),
			) as never

			const running = webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "req-4" })
			await vi.waitFor(() => expect(provider.providerSettingsManager.listConfig).toHaveBeenCalled())
			await webviewMessageHandler(provider, { type: "cancelProviderQuotas", requestId: "req-4" })
			release([{ id: "a" }])
			await running

			expect(quotas.getProviderQuotas).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("releases the handler on cancel without waiting for a profile read that never settles", async () => {
			const provider = makeProvider()
			provider.providerSettingsManager.listConfig = vi.fn(() => new Promise(() => {})) as never

			const running = webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "req-stuck" })
			await vi.waitFor(() => expect(provider.providerSettingsManager.listConfig).toHaveBeenCalled())
			await webviewMessageHandler(provider, { type: "cancelProviderQuotas", requestId: "req-stuck" })

			// Resolves although listConfig never does.
			await running
			expect(provider.providerSettingsManager.getProfile).not.toHaveBeenCalled()
			expect(quotas.getProviderQuotas).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
			expect(provider.log).not.toHaveBeenCalled()
		})

		it("keeps two webviews apart: a cancel from one never aborts the other's request with the same id", async () => {
			// Each webview has its own provider, and both number their requests from 1. Their loads are held open
			// at the profile list, so both are pending at once when the cancel arrives.
			quotas.getProviderQuotas.mockResolvedValue([])
			const releases: Array<(entries: { id: string }[]) => void> = []
			const pendingProvider = () => {
				const provider = makeProvider()
				provider.providerSettingsManager.listConfig = vi.fn(
					() => new Promise((resolve) => releases.push(resolve)),
				) as never
				return provider
			}
			const sidebar = pendingProvider()
			const editorTab = pendingProvider()

			const first = webviewMessageHandler(sidebar, {
				type: "requestProviderQuotas",
				requestId: "provider-quotas-1",
			})
			// Start them one after the other: two overlapping dynamic imports of the handler's service module can
			// resolve to the real module instead of the mock, which would make a real network call.
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			const second = webviewMessageHandler(editorTab, {
				type: "requestProviderQuotas",
				requestId: "provider-quotas-1",
			})
			await vi.waitFor(() => expect(releases).toHaveLength(2))

			// Closing Settings in the sidebar cancels the sidebar's request only.
			await webviewMessageHandler(sidebar, { type: "cancelProviderQuotas", requestId: "provider-quotas-1" })
			releases.forEach((release) => release([{ id: "a" }]))
			await Promise.all([first, second])

			// The sidebar was cancelled and is not answered. The editor tab is still answered. With one shared
			// map keyed by id alone, the cancel would have aborted the editor tab's request instead.
			expect(sidebar.postMessageToWebview).not.toHaveBeenCalled()
			expect(editorTab.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ type: "providerQuotas", requestId: "provider-quotas-1" }),
			)
			// Only the editor tab's request went on to the service; the sidebar's was stopped while loading.
			expect(quotas.getProviderQuotas).toHaveBeenCalledTimes(1)
		})

		it("lets a newer request with the same id keep its slot when the older one finishes first", async () => {
			quotas.getProviderQuotas.mockResolvedValue([])
			const releases: Array<(entries: { id: string }[]) => void> = []
			const provider = makeProvider()
			provider.providerSettingsManager.listConfig = vi.fn(
				() => new Promise((resolve) => releases.push(resolve)),
			) as never

			// Start them one after the other: see the note in the test above.
			const older = webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "same-id" })
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			const newer = webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "same-id" })
			await vi.waitFor(() => expect(releases).toHaveLength(2))

			// The older one finishes and cleans up; it must not remove the newer one's entry.
			releases[0]([{ id: "a" }])
			await older
			// The older request is answered, with a successful (empty) result.
			expect(provider.postMessageToWebview).toHaveBeenCalledTimes(1)
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
				type: "providerQuotas",
				providerQuotas: [],
				providerQuotasFailed: false,
				requestId: "same-id",
			})

			await webviewMessageHandler(provider, { type: "cancelProviderQuotas", requestId: "same-id" })
			releases[1]([{ id: "a" }])
			await newer

			// The cancel reached the newer request, so it posts nothing and the count stays at one.
			expect(provider.postMessageToWebview).toHaveBeenCalledTimes(1)
			expect(quotas.getProviderQuotas).toHaveBeenCalledTimes(1)
		})

		it("marks the answer as failed when the quotas could not be loaded, and not when there are simply none", async () => {
			const failing = makeProvider()
			failing.providerSettingsManager.listConfig = vi.fn(async () => {
				throw new Error("secret storage unavailable")
			}) as never
			await webviewMessageHandler(failing, { type: "requestProviderQuotas", requestId: "a" })
			expect(failing.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ providerQuotas: [], providerQuotasFailed: true }),
			)

			quotas.getProviderQuotas.mockResolvedValue([])
			const empty = makeProvider()
			await webviewMessageHandler(empty, { type: "requestProviderQuotas", requestId: "b" })
			expect(empty.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ providerQuotas: [], providerQuotasFailed: false }),
			)
		})

		it("ignores a cancel for an unknown or missing id, and for a request that already finished", async () => {
			const provider = makeProvider()
			await webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "req-5" })
			provider.postMessageToWebview.mockClear()

			await expect(
				webviewMessageHandler(provider, { type: "cancelProviderQuotas", requestId: "req-5" }),
			).resolves.not.toThrow()
			await expect(
				webviewMessageHandler(provider, { type: "cancelProviderQuotas", requestId: "nope" }),
			).resolves.not.toThrow()
			await expect(webviewMessageHandler(provider, { type: "cancelProviderQuotas" })).resolves.not.toThrow()
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		})
	})
})
