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
	const {
		allowedCommands,
		setAllowedCommands,
		soundEnabled,
		showRooIgnoredFiles,
		setShowRooIgnoredFiles,
		clineMessages,
		currentTaskId,
		taskHistory,
		currentTaskItem,
	} = useExtensionState()

	return (
		<div>
			<div data-testid="task-history">{JSON.stringify(taskHistory)}</div>
			<div data-testid="current-task-item">{JSON.stringify(currentTaskItem)}</div>
			<div data-testid="cline-messages">{JSON.stringify(clineMessages)}</div>
			<div data-testid="current-task-id">{currentTaskId ?? "no-task"}</div>
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

const expectMessages = (messages: ClineMessage[]) => {
	expect(JSON.parse(screen.getByTestId("cline-messages").textContent!)).toEqual(messages)
}

type InternSpy = { mock: { contexts: readonly unknown[] } }

const cacheFor = (spy: InternSpy, kind: "message" | "history"): StringCache => {
	const cache = spy.mock.contexts.find(
		(value) => value instanceof StringCache && (value["shouldIntern"] !== undefined) === (kind === "message"),
	)
	if (!(cache instanceof StringCache)) throw new Error(`Missing ${kind} cache`)
	return cache
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

const AppearanceTestComponent = () => {
	const { interfaceFontScale, terminalFontSize, editorFontSize, spacingScale } = useExtensionState()

	return (
		<div data-testid="appearance">
			{JSON.stringify({
				interfaceFontScale: interfaceFontScale ?? null,
				terminalFontSize: terminalFontSize ?? null,
				editorFontSize: editorFontSize ?? null,
				spacingScale: spacingScale ?? null,
			})}
		</div>
	)
}

const sendState = (state: Partial<ExtensionState>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }))
	})

const APPEARANCE_VARS = [
	"--zoo-ui-scale",
	"--zoo-terminal-font-size",
	"--zoo-editor-font-size",
	"--zoo-spacing-scale",
] as const

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
	it("interns initial history and current task items and subsequent state pushes", () => {
		const internSpy = vi.spyOn(StringCache.prototype, "intern")
		const item = { id: "task-a", number: 1, ts: 1, task: "history", tokensIn: 0, tokensOut: 0, totalCost: 0 }
		const currentTaskItem = { ...item, id: "task-b", task: "current" }
		const taskHistory = [item]
		render(
			<ExtensionStateContextProvider initialState={{ taskHistory, currentTaskItem }}>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)
		const cache = cacheFor(internSpy, "history")
		expect(internSpy).toHaveBeenCalledWith(taskHistory)
		expect(internSpy).toHaveBeenCalledWith(currentTaskItem)
		expect(cache.size).toBe(4)
		expect(JSON.parse(screen.getByTestId("task-history").textContent!)).toEqual(taskHistory)
		expect(JSON.parse(screen.getByTestId("current-task-item").textContent!)).toEqual(currentTaskItem)

		internSpy.mockClear()
		const updated = { ...currentTaskItem, task: "updated" }
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { currentTaskItem: updated } },
				}),
			),
		)
		expect(internSpy).toHaveBeenCalledWith(updated)
		expect(internSpy.mock.contexts).toEqual([cache])
		expect(cache.size).toBe(5)
		expect(JSON.parse(screen.getByTestId("current-task-item").textContent!)).toEqual(updated)
	})

	it("does not restore a key dropped by a snapshot message", () => {
		const payload: ClineMessage = { ts: 1, type: "say", say: "text", text: "seed", partial: false }
		const internSpy = vi.spyOn(StringCache.prototype, "intern")
		render(
			<ExtensionStateContextProvider initialState={{ clineMessages: [payload] }}>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)
		internSpy.mockClear()
		const updated: ClineMessage = { ts: 1, type: "say", say: "text", text: "seed" }
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "state", state: { clineMessages: [updated] } } }),
			),
		)
		expect(JSON.parse(screen.getByTestId("cline-messages").textContent!)[0]).not.toHaveProperty("partial")
		expectMessages([{ ts: 1, type: "say", say: "text", text: "seed" }])
		expect(internSpy).toHaveBeenCalledWith(updated)
	})

	it("updates the last duplicate timestamp in both the message mirror and rendered state", () => {
		const first: ClineMessage = { ts: 1, type: "say", say: "text", text: "first" }
		const last = { ...first, text: "last" }
		const updated = { ...last, text: "updated" }
		const internSpy = vi.spyOn(StringCache.prototype, "intern")
		render(
			<ExtensionStateContextProvider initialState={{ clineMessages: [first, last] }}>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "messageUpdated", clineMessage: updated } }),
			),
		)
		expectMessages([first, updated])
		internSpy.mockClear()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "state", state: { clineMessages: [{ ...updated }] } } }),
			),
		)
		expect(internSpy).not.toHaveBeenCalledWith(updated)
		expectMessages([updated])
	})

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
				const cache = cacheFor(internSpy, "message")
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
			if (entry === "taskHistoryUpdated" || entry === "taskHistoryItemUpdated") {
				expect(JSON.parse(screen.getByTestId("task-history").textContent!)).toEqual([item])
			}
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
			const oldTaskOnly: ClineMessage = { ts: 2, type: "say", say: "text", text: "old-task-only" }
			render(
				<ExtensionStateContextProvider
					initialState={{
						currentTaskId: "task-a",
						clineMessages: scenario === "task switch" ? [payload, oldTaskOnly] : [payload],
					}}>
					<TestComponent />
				</ExtensionStateContextProvider>,
			)
			const dispatch = (data: ExtensionMessage) =>
				act(() => window.dispatchEvent(new MessageEvent("message", { data })))
			if (scenario === "task switch") {
				internSpy.mockClear()
				dispatch({ type: "state", state: { currentTaskId: "task-b", clineMessages: [{ ...payload }] } })
				expect(internSpy).toHaveBeenCalledWith(payload)
				expectMessages([payload])
				expect(screen.getByTestId("current-task-id")).toHaveTextContent("task-b")
			} else {
				const updated = { ...payload, text: "updated" }
				dispatch({ type: "messageUpdated", clineMessage: updated })
				expectMessages([updated])
				internSpy.mockClear()
				dispatch({ type: "state", state: { currentTaskId: "task-a", clineMessages: [{ ...updated }] } })
				expect(internSpy).not.toHaveBeenCalledWith(updated)
				expectMessages([updated])
			}
		},
	)

	it("keeps the task item with the pinned task id unless it updates the same task", () => {
		const item = (id: string, task: string) => ({
			id,
			number: 1,
			ts: 1,
			task,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		})
		const initial = {
			...createInitialExtensionState(),
			currentTaskId: "task-a",
			currentTaskItem: item("task-a", "a"),
			clineMessagesSeq: 5,
		}
		const other = { currentTaskId: "task-b", currentTaskItem: item("task-b", "b") }
		const sameTask = { currentTaskId: "task-a", currentTaskItem: item("task-a", "a2") }
		const stale = { clineMessages: [], clineMessagesSeq: 4 }

		for (const extra of [{}, stale]) {
			expect(mergeExtensionState(initial, { ...other, ...extra }).currentTaskItem).toBe(initial.currentTaskItem)
			expect(mergeExtensionState(initial, { ...sameTask, ...extra }).currentTaskItem).toBe(
				sameTask.currentTaskItem,
			)
		}
		expect(mergeExtensionState(initial, { ...other, clineMessages: [], clineMessagesSeq: 6 }).currentTaskItem).toBe(
			other.currentTaskItem,
		)
	})

	it("ignores task identity in pushes without messages", () => {
		// Settings, telemetry and mode refreshes do not switch tasks; their snapshots can arrive late.
		const initial = { ...createInitialExtensionState(), currentTaskId: "task-a" }
		expect(mergeExtensionState(initial, { currentTaskId: "old" }).currentTaskId).toBe("task-a")
		const internSpy = vi.spyOn(StringCache.prototype, "intern")
		const payload: ClineMessage = { ts: 1, type: "say", say: "text", text: "seed" }
		render(
			<ExtensionStateContextProvider initialState={{ ...initial, clineMessages: [payload] }}>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)
		const cache = cacheFor(internSpy, "message")
		if (!(cache instanceof StringCache)) throw new Error("Missing cache")
		const size = cache.size
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "state", state: { currentTaskId: "old" } } }),
			),
		)
		expect(cache.size).toBe(size)
		expectMessages([payload])
		expect(screen.getByTestId("current-task-id")).toHaveTextContent("task-a")
		internSpy.mockClear()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { currentTaskId: "task-a", clineMessages: [{ ...payload }] } },
				}),
			),
		)
		expect(internSpy).not.toHaveBeenCalledWith(payload)
		expectMessages([payload])
		expect(screen.getByTestId("current-task-id")).toHaveTextContent("task-a")
	})

	it("does not retain partial messages or re-intern unchanged snapshot messages", () => {
		const internSpy = vi.spyOn(StringCache.prototype, "intern")
		const payload: ClineMessage = { ts: 1, type: "say", say: "text", text: "streaming", partial: true }
		render(
			<ExtensionStateContextProvider initialState={{ clineMessages: [payload] }}>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)
		const cache = cacheFor(internSpy, "message")
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
		// JSON serialization intentionally drops undefined, reproducing the extension transport.
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
		const messageCache = cacheFor(internSpy, "message")
		const historyCache = cacheFor(internSpy, "history")
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
		const clearSpy = vi.spyOn(StringCache.prototype, "clear")
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: {
							currentTaskId: "task-a",
							clineMessages: [{ ts: 1, type: "say", say: "text", text: "seed" }],
							clineMessagesSeq: 6,
						},
					},
				}),
			),
		)
		expect(clearSpy).not.toHaveBeenCalled()
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
		const messageCache = cacheFor(internSpy, "message")
		const historyCache = cacheFor(internSpy, "history")
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
					// Keep the JSON round trip: structuredClone would preserve the absent-task key.
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
		expectMessages([])

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { clineMessages: [currentMessage], clineMessagesSeq: 6 } },
				}),
			)
		})
		expect(internSpy).toHaveBeenCalledWith(currentMessage)
		expectMessages([currentMessage])
		internSpy.mockClear()
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { clineMessages: [staleMessage], clineMessagesSeq: 6 } },
				}),
			)
		})
		expect(internSpy).not.toHaveBeenCalledWith(staleMessage)
		expectMessages([currentMessage])
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
		expectMessages([currentMessage])
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

	describe("appearance settings", () => {
		const clearVars = () => {
			for (const name of APPEARANCE_VARS) document.documentElement.style.removeProperty(name)
			document.documentElement.classList.remove("zoo-editor-font-set")
		}
		const appearance = () => JSON.parse(screen.getByTestId("appearance").textContent!)
		const renderAppearance = () =>
			render(
				<ExtensionStateContextProvider>
					<AppearanceTestComponent />
				</ExtensionStateContextProvider>,
			)

		beforeEach(clearVars)
		afterEach(clearVars)

		it("leaves every value unset and the CSS variables absent before any state arrives", () => {
			renderAppearance()

			expect(appearance()).toEqual({
				interfaceFontScale: null,
				terminalFontSize: null,
				editorFontSize: null,
				spacingScale: null,
			})
			for (const name of APPEARANCE_VARS) expect(document.documentElement.style.getPropertyValue(name)).toBe("")
		})

		it("hydrates all four values from the host state and applies their CSS variables", () => {
			renderAppearance()

			sendState({ interfaceFontScale: 120, terminalFontSize: 14, editorFontSize: 15, spacingScale: 80 })

			expect(appearance()).toEqual({
				interfaceFontScale: 120,
				terminalFontSize: 14,
				editorFontSize: 15,
				spacingScale: 80,
			})
			const style = document.documentElement.style
			expect(style.getPropertyValue("--zoo-ui-scale")).toBe("1.2")
			expect(style.getPropertyValue("--zoo-terminal-font-size")).toBe("14px")
			expect(style.getPropertyValue("--zoo-editor-font-size")).toBe("15px")
			expect(style.getPropertyValue("--zoo-spacing-scale")).toBe("0.8")
		})

		it("treats a null from the host (a saved reset) as unset and removes the CSS variables", () => {
			renderAppearance()
			sendState({ interfaceFontScale: 120, terminalFontSize: 14, editorFontSize: 15, spacingScale: 80 })

			sendState({ interfaceFontScale: null, terminalFontSize: null, editorFontSize: null, spacingScale: null })

			expect(appearance()).toEqual({
				interfaceFontScale: null,
				terminalFontSize: null,
				editorFontSize: null,
				spacingScale: null,
			})
			for (const name of APPEARANCE_VARS) expect(document.documentElement.style.getPropertyValue(name)).toBe("")
		})

		it("updates one value without disturbing the others", () => {
			renderAppearance()
			sendState({ interfaceFontScale: 120, terminalFontSize: 14 })

			sendState({ terminalFontSize: 18 })

			expect(appearance()).toMatchObject({ interfaceFontScale: 120, terminalFontSize: 18 })
			expect(document.documentElement.style.getPropertyValue("--zoo-ui-scale")).toBe("1.2")
			expect(document.documentElement.style.getPropertyValue("--zoo-terminal-font-size")).toBe("18px")
		})
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
