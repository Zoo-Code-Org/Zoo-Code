import { beforeEach, describe, expect, it } from "vitest"

import {
	PROMPT_HISTORY_STORAGE_KEY,
	autosavePromptHistoryDraft,
	readPersistedPromptHistory,
	readPersistedPromptHistoryTexts,
	recordPromptHistorySend,
	resetActivePromptHistoryDraft,
} from "../promptHistory"

const createMemoryStorage = (): Storage => {
	const entries = new Map<string, string>()

	return {
		get length() {
			return entries.size
		},
		clear: () => entries.clear(),
		getItem: (key: string) => entries.get(key) ?? null,
		key: (index: number) => Array.from(entries.keys())[index] ?? null,
		removeItem: (key: string) => entries.delete(key),
		setItem: (key: string, value: string) => entries.set(key, String(value)),
	}
}

describe("promptHistory", () => {
	beforeEach(() => {
		Object.defineProperty(window, "localStorage", {
			value: createMemoryStorage(),
			configurable: true,
		})
		window.localStorage.clear()
		resetActivePromptHistoryDraft()
	})

	it("autosaves one active draft and updates it in place", () => {
		expect(autosavePromptHistoryDraft("first draft", "/repo-a")).toBe(true)
		expect(autosavePromptHistoryDraft("updated draft", "/repo-a")).toBe(true)

		const entries = readPersistedPromptHistory()
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({
			text: "updated draft",
			source: "draft",
			workspace: "/repo-a",
		})
	})

	it("records sent prompts and filters by workspace", () => {
		recordPromptHistorySend("repo a prompt", "/repo-a")
		recordPromptHistorySend("repo b prompt", "/repo-b")

		expect(readPersistedPromptHistoryTexts("/repo-a")).toEqual(["repo a prompt"])
		expect(readPersistedPromptHistoryTexts("/repo-b")).toEqual(["repo b prompt"])
		expect(readPersistedPromptHistoryTexts()).toEqual(expect.arrayContaining(["repo a prompt", "repo b prompt"]))
	})

	it("ignores invalid persisted storage", () => {
		window.localStorage.setItem(PROMPT_HISTORY_STORAGE_KEY, JSON.stringify({ bad: true }))

		expect(readPersistedPromptHistory()).toEqual([])
	})
})
