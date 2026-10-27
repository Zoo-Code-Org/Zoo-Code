import { providerIdentifiers } from "@roo-code/types"
import { render, screen, act } from "@/utils/test-utils"
import React from "react"

import {
	type ProviderSettings,
	type ExperimentId,
	type ExtensionState,
	type ClineMessage,
	type ExtensionMessage,
	type MarketplaceItem,
	type MarketplaceInstalledMetadata,
	type RouterModels,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	DEFAULT_DIFF_FUZZY_THRESHOLD,
	DEFAULT_WRITE_DELAY_MS,
} from "@roo-code/types"

import {
	ExtensionStateContextProvider,
	useExtensionState,
	mergeExtensionState,
	createInitialExtensionState,
} from "../ExtensionStateContext"
import { StringCache } from "@/utils/stringCache"

const TestComponent = () => {
	const { allowedCommands, setAllowedCommands, soundEnabled, showRooIgnoredFiles, setShowRooIgnoredFiles } =
		useExtensionState()

	return (
		<div>
			<div data-testid="allowed-commands">{JSON.stringify(allowedCommands)}</div>
			<div data-testid="sound-enabled">{JSON.stringify(soundEnabled)}</div>
			<div data-testid="show-rooignored-files">{JSON.stringify(showRooIgnoredFiles)}</div>
			<button data-testid="update-button" onClick={() => setAllowedCommands(["npm install", "git status"])}>
				Update Commands
			</button>
			<button data-testid="toggle-rooignore-button" onClick={() => setShowRooIgnoredFiles(!showRooIgnoredFiles)}>
				Update Commands
			</button>
		</div>
	)
}

const RulesTestComponent = () => {
	const { rules } = useExtensionState()

	return <div data-testid="rules">{JSON.stringify(rules)}</div>
}

const ChatFontSizeTestComponent = () => {
	const { chatFontSize, setChatFontSize } = useExtensionState()

	return (
		<div>
			<div data-testid="chat-font-size">{JSON.stringify(chatFontSize ?? null)}</div>
			<button data-testid="set-font-size-button" onClick={() => setChatFontSize(20)}>
				Set Font Size
			</button>
			<button data-testid="reset-font-size-button" onClick={() => setChatFontSize(undefined)}>
				Reset Font Size
			</button>
		</div>
	)
}

const ApiConfigTestComponent = () => {
	const { apiConfiguration, setApiConfiguration } = useExtensionState()

	return (
		<div>
			<div data-testid="api-configuration">{JSON.stringify(apiConfiguration)}</div>
			<button
				data-testid="update-api-config-button"
				onClick={() =>
					setApiConfiguration({ apiModelId: "new-model", apiProvider: providerIdentifiers.anthropic })
				}>
				Update API Config
			</button>
			<button data-testid="partial-update-button" onClick={() => setApiConfiguration({ modelTemperature: 0.7 })}>
				Partial Update
			</button>
		</div>
	)
}

const InitialStateTestComponent = () => {
	const {
		alwaysAllowFollowupQuestions,
		followupAutoApproveTimeoutMs,
		includeTaskHistoryInEnhance,
		includeCurrentTime,
		includeCurrentCost,
		routerModels,
		marketplaceItems,
		marketplaceInstalledMetadata,
	} = useExtensionState()

	return (
		<div data-testid="initial-state">
			{JSON.stringify({
				alwaysAllowFollowupQuestions,
				followupAutoApproveTimeoutMs,
				includeTaskHistoryInEnhance,
				includeCurrentTime,
				includeCurrentCost,
				routerModels,
				marketplaceItems,
				marketplaceInstalledMetadata,
			})}
		</div>
	)
}

describe("ExtensionStateContext", () => {
	afterEach(() => vi.restoreAllMocks())
	it.each(["initial", "state", "messageUpdated", "taskHistoryUpdated", "taskHistoryItemUpdated"] as const)(
		"interns accepted payloads through %s",
		(entry) => {
			const internSpy = vi.spyOn(StringCache.prototype, "intern")
			const payload: ClineMessage = { ts: 1, type: "say", say: "text", text: "accepted" }
			const item = { id: "task-a", number: 1, ts: 1, task: "history", tokensIn: 0, tokensOut: 0, totalCost: 0 }
			render(
				<ExtensionStateContextProvider initialState={{ clineMessages: [payload] }}>
					<TestComponent />
				</ExtensionStateContextProvider>,
			)
			if (entry === "initial") {
				expect(internSpy).toHaveBeenCalledWith(payload)
				const cache = internSpy.mock.contexts[0]
				expect(cache).toBeInstanceOf(StringCache)
				if (!(cache instanceof StringCache)) throw new Error("Missing cache")
				expect(typeof cache["shouldIntern"]).toBe("function")
				expect(cache.size).toBeGreaterThan(0)
				return
			}
			const caches = internSpy.mock.contexts.filter((cache): cache is StringCache => cache instanceof StringCache)
			const targetCache = caches.find(
				(cache) => (cache["shouldIntern"] !== undefined) === (entry === "state" || entry === "messageUpdated"),
			)
			if (!targetCache) throw new Error("Missing target cache")
			const sizeBefore = targetCache.size
			internSpy.mockClear()
			const messages: Record<Exclude<typeof entry, "initial">, ExtensionMessage> = {
				state: { type: "state", state: { clineMessages: [{ ...payload, text: "changed" }] } },
				messageUpdated: { type: "messageUpdated", clineMessage: { ...payload, text: "updated" } },
				taskHistoryUpdated: { type: "taskHistoryUpdated", taskHistory: [item] },
				taskHistoryItemUpdated: { type: "taskHistoryItemUpdated", taskHistoryItem: item },
			}
			act(() => window.dispatchEvent(new MessageEvent("message", { data: messages[entry] })))
			expect(internSpy.mock.contexts).toEqual([targetCache])
			expect(targetCache.size).toBeGreaterThan(sizeBefore)
			expect(internSpy).toHaveBeenCalledWith(
				entry === "state"
					? expect.objectContaining({ text: "changed" })
					: entry === "messageUpdated"
						? { ...payload, text: "updated" }
						: entry === "taskHistoryUpdated"
							? [item]
							: item,
			)
		},
	)

	it.each(["task switch", "message update"] as const)(
		"keeps the message mirror synchronized after %s",
		(scenario) => {
			const internSpy = vi.spyOn(StringCache.prototype, "intern")
			const payload: ClineMessage = { ts: 1, type: "say", say: "text", text: "seed" }
			render(
				<ExtensionStateContextProvider initialState={{ currentTaskId: "task-a", clineMessages: [payload] }}>
					<TestComponent />
				</ExtensionStateContextProvider>,
			)
			const dispatch = (data: ExtensionMessage) =>
				act(() => window.dispatchEvent(new MessageEvent("message", { data })))
			if (scenario === "task switch") {
				internSpy.mockClear()
				dispatch({ type: "state", state: { currentTaskId: "task-b", clineMessages: [{ ...payload }] } })
				expect(internSpy).toHaveBeenCalledWith(payload)
			} else {
				const updated = { ...payload, text: "updated" }
				dispatch({ type: "messageUpdated", clineMessage: updated })
				internSpy.mockClear()
				dispatch({ type: "state", state: { currentTaskId: "task-a", clineMessages: [{ ...updated }] } })
				expect(internSpy).not.toHaveBeenCalledWith(updated)
			}
		},
	)

	it("ignores task identity in pushes without messages", () => {
		const initial = { ...createInitialExtensionState(), currentTaskId: "task-a" }
		expect(mergeExtensionState(initial, { currentTaskId: "old" }).currentTaskId).toBe("task-a")
		const internSpy = vi.spyOn(StringCache.prototype, "intern")
		const payload: ClineMessage = { ts: 1, type: "say", say: "text", text: "seed" }
		render(
			<ExtensionStateContextProvider initialState={{ ...initial, clineMessages: [payload] }}>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)
		const cache = internSpy.mock.contexts[0]
		if (!(cache instanceof StringCache)) throw new Error("Missing cache")
		const size = cache.size
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "state", state: { currentTaskId: "old" } } }),
			),
		)
		expect(cache.size).toBe(size)
		internSpy.mockClear()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { currentTaskId: "task-a", clineMessages: [{ ...payload }] } },
				}),
			),
		)
		expect(internSpy).not.toHaveBeenCalledWith(payload)
	})

	it("does not retain partial messages or re-intern unchanged snapshot messages", () => {
		const internSpy = vi.spyOn(StringCache.prototype, "intern")
		const payload: ClineMessage = { ts: 1, type: "say", say: "text", text: "streaming", partial: true }
		render(
			<ExtensionStateContextProvider initialState={{ clineMessages: [payload] }}>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)
		const cache = internSpy.mock.contexts[0]
		if (!(cache instanceof StringCache)) throw new Error("Missing message cache")
		expect(cache?.size).toBe(0)
		internSpy.mockClear()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "state", state: { clineMessages: [{ ...payload }] } } }),
			),
		)
		expect(internSpy).not.toHaveBeenCalledWith(payload)
		expect(cache?.size).toBe(0)
	})

	it("clears a serialized absent task id and preserves task identity on stale snapshots", () => {
		const initial = { ...createInitialExtensionState(), currentTaskId: "task-a", clineMessagesSeq: 5 }
		const cleared = mergeExtensionState(
			initial,
			JSON.parse(JSON.stringify({ currentTaskId: undefined, clineMessages: [], clineMessagesSeq: 6 })),
		)
		expect(cleared.currentTaskId).toBeUndefined()
		const stale = mergeExtensionState(initial, {
			currentTaskId: "old-task",
			clineMessages: [],
			clineMessagesSeq: 4,
		})
		expect(stale.currentTaskId).toBe("task-a")
	})

	it("preserves the message cache on stale task pushes and rebuilds replaced history", () => {
		const internSpy = vi.spyOn(StringCache.prototype, "intern")
		render(
			<ExtensionStateContextProvider
				initialState={{
					currentTaskId: "task-a",
					clineMessagesSeq: 5,
					clineMessages: [{ ts: 1, type: "say", say: "text", text: "seed" }],
				}}>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)
		const messageCache = internSpy.mock.contexts[0]
		const historyCache = internSpy.mock.contexts[1]
		if (!(messageCache instanceof StringCache) || !(historyCache instanceof StringCache))
			throw new Error("Missing caches")
		const messageSize = messageCache.size
		historyCache.intern("removed-history")
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { currentTaskId: "old", clineMessages: [], clineMessagesSeq: 4 } },
				}),
			),
		)
		expect(messageCache.size).toBe(messageSize)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "taskHistoryUpdated", taskHistory: [] } }),
			),
		)
		expect(historyCache.size).toBe(0)
		expect(messageCache.size).toBe(messageSize)
		historyCache.intern("removed-again")
		act(() =>
			window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state: { taskHistory: [] } } })),
		)
		expect(historyCache.size).toBe(0)
	})

	it("clears the task-scoped message cache only on explicit task transitions", () => {
		const internSpy = vi.spyOn(StringCache.prototype, "intern")
		const clearSpy = vi.spyOn(StringCache.prototype, "clear")
		render(
			<ExtensionStateContextProvider
				initialState={{
					currentTaskId: "task-a",
					clineMessages: [{ ts: 1, type: "say", say: "text", text: "seed" }],
				}}>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)
		const messageCache = internSpy.mock.contexts[0]
		const historyCache = internSpy.mock.contexts[1]
		if (!(messageCache instanceof StringCache) || !(historyCache instanceof StringCache)) {
			throw new Error("Missing provider caches")
		}
		expect(messageCache?.size).toBeGreaterThan(0)
		historyCache?.intern("history-seed")
		const historySize = historyCache?.size
		clearSpy.mockClear()

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "state", state: { currentTaskId: "task-a" } } }),
			)
			window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state: { language: "en" } } }))
		})
		expect(clearSpy).not.toHaveBeenCalled()

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.parse(
						JSON.stringify({ type: "state", state: { currentTaskId: undefined, clineMessages: [] } }),
					),
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { currentTaskId: "task-b", clineMessages: [] } },
				}),
			)
		})
		expect(clearSpy).toHaveBeenCalledTimes(2)
		expect(messageCache?.size).toBe(0)
		expect(historyCache?.size).toBe(historySize)
	})

	it("does not intern messages from stale sequenced state updates", () => {
		const internSpy = vi.spyOn(StringCache.prototype, "intern")
		render(
			<ExtensionStateContextProvider initialState={{ clineMessagesSeq: 5 }}>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)
		internSpy.mockClear()
		const staleMessage = { ts: 1, type: "say", say: "text", text: "stale" } as ClineMessage
		const currentMessage = { ts: 2, type: "say", say: "text", text: "current" } as ClineMessage

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { clineMessages: [staleMessage], clineMessagesSeq: 5 } },
				}),
			)
		})
		expect(internSpy).not.toHaveBeenCalledWith(staleMessage)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { clineMessages: [currentMessage], clineMessagesSeq: 6 } },
				}),
			)
		})
		expect(internSpy).toHaveBeenCalledWith(currentMessage)
		internSpy.mockClear()
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { clineMessages: [staleMessage], clineMessagesSeq: 6 } },
				}),
			)
		})
		expect(internSpy).not.toHaveBeenCalledWith(staleMessage)
	})

	it("does not intern an update for a message outside the current task", () => {
		const currentMessage = { ts: 1, type: "say", say: "text", text: "current" } as ClineMessage
		const unknownMessage = { ts: 2, type: "say", say: "text", text: "late" } as ClineMessage
		const internSpy = vi.spyOn(StringCache.prototype, "intern")
		vi.spyOn(console, "warn").mockImplementation(() => undefined)
		render(
			<ExtensionStateContextProvider initialState={{ clineMessages: [currentMessage] }}>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)
		internSpy.mockClear()

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "messageUpdated", clineMessage: unknownMessage } }),
			)
		})

		expect(internSpy).not.toHaveBeenCalledWith(unknownMessage)
	})

	it("initializes with empty allowedCommands array", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("allowed-commands").textContent!)).toEqual([])
	})

	it("initializes with empty rules array", () => {
		render(
			<ExtensionStateContextProvider>
				<RulesTestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("rules").textContent!)).toEqual([])
	})

	it("updates rules from incoming rules message", () => {
		render(
			<ExtensionStateContextProvider>
				<RulesTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "rules",
						rules: [
							{
								id: "global:generic:generic:rule.md",
								name: "rule.md",
								scope: "global",
								kind: "generic",
								filePath: "/home/.roo/rules/rule.md",
								relativePath: "rule.md",
								directoryPath: "/home/.roo/rules",
							},
						],
					},
				}),
			)
		})

		expect(JSON.parse(screen.getByTestId("rules").textContent!)).toEqual([
			expect.objectContaining({ id: "global:generic:generic:rule.md", name: "rule.md" }),
		])
	})

	it("clears rules when incoming rules message omits rules", () => {
		render(
			<ExtensionStateContextProvider>
				<RulesTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "rules",
						rules: [
							{
								id: "global:generic:generic:rule.md",
								name: "rule.md",
								scope: "global",
								kind: "generic",
								filePath: "/home/.roo/rules/rule.md",
								relativePath: "rule.md",
								directoryPath: "/home/.roo/rules",
							},
						],
					},
				}),
			)
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "rules" },
				}),
			)
		})

		expect(JSON.parse(screen.getByTestId("rules").textContent!)).toEqual([])
	})

	it("initializes with soundEnabled set to false", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("sound-enabled").textContent!)).toBe(false)
	})

	it("initializes with showRooIgnoredFiles set to true", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("show-rooignored-files").textContent!)).toBe(true)
	})

	it("initializes the write delay to the pre-hydration default", () => {
		// The initializer itself (not a merge fixture) must carry the shared
		// default: a regression that dropped it from createInitialExtensionState
		// would otherwise stay hidden because the merge tests supply the key
		// manually.
		const state = createInitialExtensionState()

		expect(state.writeDelayMs).toBe(DEFAULT_WRITE_DELAY_MS)
	})

	it("initializes shadowed context fields from initialState", () => {
		const routerModels = {} as RouterModels
		const marketplaceItems: MarketplaceItem[] = [
			{
				id: "mode-item",
				name: "Test mode",
				description: "A test mode",
				type: "mode",
				content: "custom mode content",
			},
		]
		const marketplaceInstalledMetadata: MarketplaceInstalledMetadata = {
			project: { "mode-item": { type: "mode" } },
			global: {},
		}

		render(
			<ExtensionStateContextProvider
				initialState={{
					alwaysAllowFollowupQuestions: true,
					followupAutoApproveTimeoutMs: 1500,
					includeTaskHistoryInEnhance: false,
					includeCurrentTime: false,
					includeCurrentCost: false,
					routerModels,
					marketplaceItems,
					marketplaceInstalledMetadata,
				}}>
				<InitialStateTestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("initial-state").textContent!)).toEqual({
			alwaysAllowFollowupQuestions: true,
			followupAutoApproveTimeoutMs: 1500,
			includeTaskHistoryInEnhance: false,
			includeCurrentTime: false,
			includeCurrentCost: false,
			routerModels: {},
			marketplaceItems,
			marketplaceInstalledMetadata,
		})
	})

	it("updates showRooIgnoredFiles through setShowRooIgnoredFiles", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("toggle-rooignore-button").click()
		})

		expect(JSON.parse(screen.getByTestId("show-rooignored-files").textContent!)).toBe(false)
	})

	it("does not set the chat font-size CSS variable when unset (init)", () => {
		document.documentElement.style.removeProperty("--zoo-chat-font-size")

		render(
			<ExtensionStateContextProvider>
				<ChatFontSizeTestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("chat-font-size").textContent!)).toBe(null)
		expect(document.documentElement.style.getPropertyValue("--zoo-chat-font-size")).toBe("")
	})

	it("applies the chat font-size CSS variable when set, and clears it on reset", () => {
		document.documentElement.style.removeProperty("--zoo-chat-font-size")

		render(
			<ExtensionStateContextProvider>
				<ChatFontSizeTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("set-font-size-button").click()
		})

		expect(JSON.parse(screen.getByTestId("chat-font-size").textContent!)).toBe(20)
		expect(document.documentElement.style.getPropertyValue("--zoo-chat-font-size")).toBe("20px")

		act(() => {
			screen.getByTestId("reset-font-size-button").click()
		})

		expect(JSON.parse(screen.getByTestId("chat-font-size").textContent!)).toBe(null)
		expect(document.documentElement.style.getPropertyValue("--zoo-chat-font-size")).toBe("")
	})

	it("updates allowedCommands through setAllowedCommands", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("update-button").click()
		})

		expect(JSON.parse(screen.getByTestId("allowed-commands").textContent!)).toEqual(["npm install", "git status"])
	})

	it("throws error when used outside provider", () => {
		const useContextSpy = vi.spyOn(React, "useContext").mockReturnValue(undefined)

		try {
			expect(() => useExtensionState()).toThrow(
				"useExtensionState must be used within an ExtensionStateContextProvider",
			)
		} finally {
			useContextSpy.mockRestore()
		}
	})

	it("updates apiConfiguration through setApiConfiguration", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiConfigTestComponent />
			</ExtensionStateContextProvider>,
		)

		const initialContent = screen.getByTestId("api-configuration").textContent!
		expect(initialContent).toBeDefined()

		act(() => {
			screen.getByTestId("update-api-config-button").click()
		})

		const updatedContent = screen.getByTestId("api-configuration").textContent!
		const updatedConfig = JSON.parse(updatedContent || "{}")

		expect(updatedConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model",
				apiProvider: providerIdentifiers.anthropic,
			}),
		)
	})

	it("correctly merges partial updates to apiConfiguration", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiConfigTestComponent />
			</ExtensionStateContextProvider>,
		)

		// First set the initial configuration
		act(() => {
			screen.getByTestId("update-api-config-button").click()
		})

		// Verify initial update
		const initialContent = screen.getByTestId("api-configuration").textContent!
		const initialConfig = JSON.parse(initialContent || "{}")
		expect(initialConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model",
				apiProvider: providerIdentifiers.anthropic,
			}),
		)

		// Now perform a partial update
		act(() => {
			screen.getByTestId("partial-update-button").click()
		})

		// Verify that the partial update was merged with the existing configuration
		const updatedContent = screen.getByTestId("api-configuration").textContent!
		const updatedConfig = JSON.parse(updatedContent || "{}")
		expect(updatedConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model", // Should retain this from previous update
				apiProvider: providerIdentifiers.anthropic, // Should retain this from previous update
				modelTemperature: 0.7, // Should add this from partial update
			}),
		)
	})
})

describe("mergeExtensionState", () => {
	it("should correctly merge extension states", () => {
		const baseState: ExtensionState = {
			version: "",
			mcpEnabled: false,
			clineMessages: [],
			taskHistory: [],
			shouldShowAnnouncement: false,
			enableCheckpoints: true,
			// Matches the shared DEFAULT_WRITE_DELAY_MS (pre-hydration placeholder
			// must not disagree with the extension's own fallback).
			writeDelayMs: 0,
			mode: "default",
			experiments: {} as Record<ExperimentId, boolean>,
			customModes: [],
			maxOpenTabsContext: 20,
			maxWorkspaceFiles: 100,
			apiConfiguration: { providerId: providerIdentifiers.openrouter } as ProviderSettings,
			telemetrySetting: "unset",
			showRooIgnoredFiles: true,
			enableSubfolderRules: false,
			renderContext: "sidebar",
			cloudUserInfo: null,
			organizationAllowList: { allowAll: true, providers: {} },
			autoCondenseContext: true,
			autoCondenseContextPercent: 100,
			cloudIsAuthenticated: false,
			sharingEnabled: false,
			publicSharingEnabled: false,
			profileThresholds: {},
			hasOpenedModeSelector: false, // Add the new required property
			maxImageFileSize: 5,
			maxTotalImageSize: 20,
			taskSyncEnabled: false,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS, // Add the checkpoint timeout property
			maxReadFileLine: -1,
			diffFuzzyThreshold: DEFAULT_DIFF_FUZZY_THRESHOLD,
		}

		const prevState: ExtensionState = {
			...baseState,
			apiConfiguration: { modelMaxTokens: 1234, modelMaxThinkingTokens: 123 },
			experiments: {} as Record<ExperimentId, boolean>,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS - 5,
		}

		const newState: ExtensionState = {
			...baseState,
			apiConfiguration: { modelMaxThinkingTokens: 456, modelTemperature: 0.3 },
			experiments: {
				preventFocusDisruption: false,
				imageGeneration: false,
				runSlashCommand: false,
				customTools: false,
			} as Record<ExperimentId, boolean>,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS + 5,
		}

		const result = mergeExtensionState(prevState, newState)

		expect(result.apiConfiguration).toEqual({
			modelMaxThinkingTokens: 456,
			modelTemperature: 0.3,
		})

		expect(result.experiments).toEqual({
			preventFocusDisruption: false,
			imageGeneration: false,
			runSlashCommand: false,
			customTools: false,
		})
	})

	describe("clineMessagesSeq protection", () => {
		const baseState: ExtensionState = {
			version: "",
			mcpEnabled: false,
			clineMessages: [],
			taskHistory: [],
			shouldShowAnnouncement: false,
			enableCheckpoints: true,
			// Matches the shared DEFAULT_WRITE_DELAY_MS (pre-hydration placeholder
			// must not disagree with the extension's own fallback).
			writeDelayMs: 0,
			mode: "default",
			experiments: {} as Record<ExperimentId, boolean>,
			customModes: [],
			maxOpenTabsContext: 20,
			maxWorkspaceFiles: 100,
			apiConfiguration: {},
			telemetrySetting: "unset",
			showRooIgnoredFiles: true,
			enableSubfolderRules: false,
			renderContext: "sidebar",
			cloudUserInfo: null,
			organizationAllowList: { allowAll: true, providers: {} },
			autoCondenseContext: true,
			autoCondenseContextPercent: 100,
			cloudIsAuthenticated: false,
			sharingEnabled: false,
			publicSharingEnabled: false,
			profileThresholds: {},
			hasOpenedModeSelector: false,
			maxImageFileSize: 5,
			maxTotalImageSize: 20,
			taskSyncEnabled: false,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			maxReadFileLine: -1,
			diffFuzzyThreshold: DEFAULT_DIFF_FUZZY_THRESHOLD,
		}

		const makeMessage = (ts: number, text: string): ClineMessage =>
			({ ts, type: "say", say: "text", text }) as ClineMessage

		it("rejects stale clineMessages when seq is not newer", () => {
			const newerMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]
			const staleMessages = [makeMessage(1, "hello")]

			const prevState: ExtensionState = {
				...baseState,
				clineMessages: newerMessages,
				clineMessagesSeq: 5,
			}

			const result = mergeExtensionState(prevState, {
				clineMessages: staleMessages,
				clineMessagesSeq: 3, // stale seq
			})

			// Should keep the newer messages
			expect(result.clineMessages).toBe(newerMessages)
			expect(result.clineMessagesSeq).toBe(5)
		})

		it("rejects clineMessages when seq equals current (not strictly greater)", () => {
			const currentMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]
			const sameSeqMessages = [makeMessage(1, "hello")]

			const prevState: ExtensionState = {
				...baseState,
				clineMessages: currentMessages,
				clineMessagesSeq: 5,
			}

			const result = mergeExtensionState(prevState, {
				clineMessages: sameSeqMessages,
				clineMessagesSeq: 5, // same seq, not strictly greater
			})

			expect(result.clineMessages).toBe(currentMessages)
			expect(result.clineMessagesSeq).toBe(5)
		})

		it("accepts clineMessages when seq is strictly greater", () => {
			const oldMessages = [makeMessage(1, "hello")]
			const newMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]

			const prevState: ExtensionState = {
				...baseState,
				clineMessages: oldMessages,
				clineMessagesSeq: 3,
			}

			const result = mergeExtensionState(prevState, {
				clineMessages: newMessages,
				clineMessagesSeq: 4, // newer seq
			})

			expect(result.clineMessages).toBe(newMessages)
			expect(result.clineMessagesSeq).toBe(4)
		})

		it("preserves clineMessages when newState does not include them (cloud event path)", () => {
			const existingMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]

			const prevState: ExtensionState = {
				...baseState,
				clineMessages: existingMessages,
				clineMessagesSeq: 5,
			}

			// Simulate a cloud event push that omits clineMessages and clineMessagesSeq
			const result = mergeExtensionState(prevState, {
				cloudIsAuthenticated: true,
			})

			expect(result.clineMessages).toBe(existingMessages)
			expect(result.clineMessagesSeq).toBe(5)
		})

		it("applies clineMessages normally when neither state has seq (backward compat)", () => {
			const oldMessages = [makeMessage(1, "hello")]
			const newMessages = [makeMessage(1, "hello"), makeMessage(2, "world")]

			const prevState: ExtensionState = {
				...baseState,
				clineMessages: oldMessages,
			}

			const result = mergeExtensionState(prevState, {
				clineMessages: newMessages,
			})

			expect(result.clineMessages).toBe(newMessages)
		})

		it("applies clineMessages when prevState has no seq but newState does (first push)", () => {
			const prevState: ExtensionState = {
				...baseState,
				clineMessages: [],
			}

			const newMessages = [makeMessage(1, "hello")]
			const result = mergeExtensionState(prevState, {
				clineMessages: newMessages,
				clineMessagesSeq: 1,
			})

			expect(result.clineMessages).toBe(newMessages)
			expect(result.clineMessagesSeq).toBe(1)
		})
	})
})
