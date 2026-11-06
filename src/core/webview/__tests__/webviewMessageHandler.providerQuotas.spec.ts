// npx vitest core/webview/__tests__/webviewMessageHandler.providerQuotas.spec.ts

import { beforeEach, describe, expect, it, vi } from "vitest"

import { providerIdentifiers, type OrganizationAllowList } from "@roo-code/types"

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

const ALLOW_ALL: OrganizationAllowList = { allowAll: true, providers: {} }

const makeProvider = (overrides: Record<string, unknown> = {}) =>
	({
		postMessageToWebview: vi.fn(),
		log: vi.fn(),
		getState: vi.fn(async () => ({ organizationAllowList: ALLOW_ALL })),
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

	describe("the organisation allow list", () => {
		const onlyOpenRouter: OrganizationAllowList = {
			allowAll: false,
			providers: { [providerIdentifiers.openrouter]: { allowAll: true } },
		}
		const profileBy = (providerForId: Record<string, string>) => ({
			listConfig: vi.fn(async () => [
				{ id: "a", name: "work" },
				{ id: "b", name: "personal" },
			]),
			getProfile: vi.fn(async ({ id }: { id: string }) => ({
				apiProvider: providerForId[id],
				apiKey: `key-${id}`,
				id,
			})),
		})
		const request = async (
			organizationAllowList: OrganizationAllowList,
			active: string,
			providers: Record<string, string>,
		) => {
			const provider = makeProvider({
				getState: vi.fn(async () => ({ organizationAllowList })),
				contextProxy: { getValue: vi.fn(() => active) },
				providerSettingsManager: profileBy(providers),
			})
			await webviewMessageHandler(provider, { type: "requestProviderQuotas" })
			return provider
		}
		const providers = { a: providerIdentifiers.openrouter, b: providerIdentifiers.anthropic }
		const queried = () => quotas.getProviderQuotas.mock.calls[0][0].map((p: { id: string }) => p.id) as string[]

		it("keeps a profile it refuses out of the quota request, with its credentials", async () => {
			await request(onlyOpenRouter, "work", providers)

			expect(queried()).toEqual(["a"])
			expect(JSON.stringify(quotas.getProviderQuotas.mock.calls)).not.toContain("key-b")
		})

		it("does not name a refused profile as the active one, and still names an allowed one", async () => {
			await request(onlyOpenRouter, "personal", providers) // the active profile is the refused one
			expect(quotas.getProviderQuotas.mock.calls[0][1].activeProfileId).toBeUndefined()

			quotas.getProviderQuotas.mockClear()
			await request(onlyOpenRouter, "work", providers)
			expect(quotas.getProviderQuotas.mock.calls[0][1].activeProfileId).toBe("a")
		})

		it("queries nothing for a profile of a provider the list does not name, and posts no failure for it", async () => {
			const provider = await request(onlyOpenRouter, "personal", { a: providers.b, b: providers.b })

			expect(queried()).toEqual([])
			expect(provider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ type: "providerQuotas", providerQuotasFailed: false }),
			)
		})

		it("reads the allow list without the task history, which it does not use", async () => {
			const provider = await request(onlyOpenRouter, "work", providers)

			expect(provider.getState).toHaveBeenCalledExactlyOnceWith({ includeTaskHistory: false })
		})

		it("queries every profile when the list allows all", async () => {
			await request(ALLOW_ALL, "personal", providers)

			expect(queried()).toEqual(["b", "a"])
			expect(quotas.getProviderQuotas.mock.calls[0][1].activeProfileId).toBe("b")
		})

		it("reports a failure, and queries nothing, when the allow list cannot be read", async () => {
			const provider = makeProvider({
				getState: vi.fn(async () => {
					throw new Error("state unavailable")
				}),
			})
			await webviewMessageHandler(provider, { type: "requestProviderQuotas" })

			expect(quotas.getProviderQuotas).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ providerQuotas: [], providerQuotasFailed: true }),
			)
		})
	})

	// The manager reads every profile in one locked read; the doubles above are sources without it.
	describe("with a source that reads every profile at once", () => {
		const rows = (providerForId: Record<string, string>) =>
			Object.entries(providerForId).map(([id, apiProvider]) => ({
				id,
				name: id === "a" ? "work" : "personal",
				apiProvider,
				apiKey: `key-${id}`,
			}))
		const bulkProvider = (getAllProfiles: () => Promise<unknown>, overrides: Record<string, unknown> = {}) => {
			const manager = {
				getAllProfiles: vi.fn(getAllProfiles),
				listConfig: vi.fn(),
				getProfile: vi.fn(),
			}
			return {
				manager,
				provider: makeProvider({ providerSettingsManager: manager, ...overrides }),
			}
		}
		const queried = () => quotas.getProviderQuotas.mock.calls[0][0].map((p: { id: string }) => p.id) as string[]

		it("reads once, puts the active profile first and names it", async () => {
			const { provider, manager } = bulkProvider(
				async () => rows({ a: providerIdentifiers.openrouter, b: providerIdentifiers.openrouter }),
				{ contextProxy: { getValue: vi.fn(() => "personal") } },
			)

			await webviewMessageHandler(provider, { type: "requestProviderQuotas" })

			expect(manager.getAllProfiles).toHaveBeenCalledTimes(1)
			expect(manager.listConfig).not.toHaveBeenCalled()
			expect(manager.getProfile).not.toHaveBeenCalled()
			expect(queried()).toEqual(["b", "a"])
			expect(quotas.getProviderQuotas.mock.calls[0][1].activeProfileId).toBe("b")
		})

		it("keeps a profile the allow list refuses out of the request, and does not name it as the active one", async () => {
			const onlyOpenRouter: OrganizationAllowList = {
				allowAll: false,
				providers: { [providerIdentifiers.openrouter]: { allowAll: true } },
			}
			const { provider } = bulkProvider(
				async () => rows({ a: providerIdentifiers.openrouter, b: providerIdentifiers.anthropic }),
				{
					getState: vi.fn(async () => ({ organizationAllowList: onlyOpenRouter })),
					contextProxy: { getValue: vi.fn(() => "personal") },
				},
			)

			await webviewMessageHandler(provider, { type: "requestProviderQuotas" })

			expect(queried()).toEqual(["a"])
			expect(JSON.stringify(quotas.getProviderQuotas.mock.calls)).not.toContain("key-b")
			expect(quotas.getProviderQuotas.mock.calls[0][1].activeProfileId).toBeUndefined()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ providerQuotasFailed: false }),
			)
		})

		it("answers with a failure, and logs it, when the read fails", async () => {
			const { provider } = bulkProvider(async () => {
				throw new Error("secret storage unavailable")
			})

			await webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "bulk-1" })

			expect(quotas.getProviderQuotas).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "providerQuotas",
				providerQuotas: [],
				providerQuotasFailed: true,
				requestId: "bulk-1",
			})
			expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("secret storage unavailable"))
		})

		it("answers with an empty list when there are no profiles", async () => {
			quotas.getProviderQuotas.mockResolvedValue([])
			const { provider } = bulkProvider(async () => [])

			await webviewMessageHandler(provider, { type: "requestProviderQuotas" })

			expect(provider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ providerQuotas: [], providerQuotasFailed: false }),
			)
		})

		it("is released by a cancel without waiting for a read that never settles, and posts nothing", async () => {
			const { provider, manager } = bulkProvider(() => new Promise(() => {}))

			const running = webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "bulk-2" })
			await vi.waitFor(() => expect(manager.getAllProfiles).toHaveBeenCalled())
			await webviewMessageHandler(provider, { type: "cancelProviderQuotas", requestId: "bulk-2" })

			await running
			expect(quotas.getProviderQuotas).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
			expect(provider.log).not.toHaveBeenCalled()
		})

		it("starts no read for a request that was cancelled while the allow list was read", async () => {
			const { provider, manager } = bulkProvider(async () => rows({ a: providerIdentifiers.openrouter }))
			// The cancel arrives while the allow list is read, before any profile read is started.
			let releaseState: () => void = () => {}
			provider.getState = vi.fn(
				() => new Promise((resolve) => (releaseState = () => resolve({ organizationAllowList: ALLOW_ALL }))),
			) as never

			const running = webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "bulk-3" })
			await vi.waitFor(() => expect(provider.getState).toHaveBeenCalled())
			await webviewMessageHandler(provider, { type: "cancelProviderQuotas", requestId: "bulk-3" })
			releaseState()
			await running

			expect(manager.getAllProfiles).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		})
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

		it("also aborts a request that was sent without a request id", async () => {
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
			const handling = webviewMessageHandler(provider, { type: "requestProviderQuotas" })
			await vi.waitFor(() => expect(signal).toBeDefined())

			abortProviderQuotaRequests(provider)
			await handling

			expect(signal?.aborted).toBe(true)
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("keeps nothing for a request that finished, so a later disposal aborts nothing", async () => {
			const signals: AbortSignal[] = []
			quotas.getProviderQuotas.mockImplementation((_profiles: unknown, options: { signal: AbortSignal }) => {
				signals.push(options.signal)
				return Promise.resolve([])
			})
			const provider = makeProvider()
			await webviewMessageHandler(provider, { type: "requestProviderQuotas" })
			await webviewMessageHandler(provider, { type: "requestProviderQuotas", requestId: "done" })
			expect(signals).toHaveLength(2)

			abortProviderQuotaRequests(provider)

			// Both requests finished before the disposal: neither is still held, so neither signal was aborted.
			expect(signals.map((signal) => signal.aborted)).toEqual([false, false])
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
