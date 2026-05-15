const MAX_PROMPT_HISTORY_SIZE = 100

export const PROMPT_HISTORY_AUTOSAVE_INTERVAL_MS = 5_000
export const PROMPT_HISTORY_CHANGED_EVENT = "zoo:prompt-history-changed"
export const PROMPT_HISTORY_STORAGE_KEY = "zoo.chatPromptHistory.v1"

export interface PersistedPromptHistoryEntry {
	id: string
	text: string
	createdAt: number
	updatedAt: number
	source: "draft" | "sent"
	workspace?: string
}

let activeDraftId: string | null = null

const getStorage = (): Storage | undefined => {
	try {
		return typeof window !== "undefined" ? window.localStorage : undefined
	} catch {
		return undefined
	}
}

const getNow = () => Date.now()

const createId = () => {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID()
	}

	return `${getNow()}-${Math.random().toString(36).slice(2)}`
}

const normalizeWorkspace = (workspace?: string) => {
	const trimmed = workspace?.trim()
	return trimmed ? trimmed : undefined
}

const normalizeEntry = (entry: unknown): PersistedPromptHistoryEntry | undefined => {
	if (!entry || typeof entry !== "object") {
		return undefined
	}

	const candidate = entry as Partial<PersistedPromptHistoryEntry>
	const text = typeof candidate.text === "string" ? candidate.text : ""

	if (!text.trim()) {
		return undefined
	}

	const createdAt = typeof candidate.createdAt === "number" ? candidate.createdAt : getNow()
	const updatedAt = typeof candidate.updatedAt === "number" ? candidate.updatedAt : createdAt

	return {
		id: typeof candidate.id === "string" && candidate.id ? candidate.id : createId(),
		text,
		createdAt,
		updatedAt,
		source: candidate.source === "sent" ? "sent" : "draft",
		workspace: normalizeWorkspace(candidate.workspace),
	}
}

const notifyPromptHistoryChanged = () => {
	try {
		window.dispatchEvent(new Event(PROMPT_HISTORY_CHANGED_EVENT))
	} catch {
		// Ignore event dispatch failures in non-browser test environments.
	}
}

export const readPersistedPromptHistory = (): PersistedPromptHistoryEntry[] => {
	const storage = getStorage()

	if (!storage) {
		return []
	}

	try {
		const raw = storage.getItem(PROMPT_HISTORY_STORAGE_KEY)
		const parsed = raw ? JSON.parse(raw) : []

		if (!Array.isArray(parsed)) {
			return []
		}

		return parsed
			.map(normalizeEntry)
			.filter((entry): entry is PersistedPromptHistoryEntry => entry !== undefined)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, MAX_PROMPT_HISTORY_SIZE)
	} catch {
		return []
	}
}

const writePersistedPromptHistory = (entries: PersistedPromptHistoryEntry[]) => {
	const storage = getStorage()

	if (!storage) {
		return false
	}

	try {
		storage.setItem(PROMPT_HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_PROMPT_HISTORY_SIZE)))
		notifyPromptHistoryChanged()
		return true
	} catch {
		return false
	}
}

export const readPersistedPromptHistoryTexts = (workspace?: string): string[] => {
	const normalizedWorkspace = normalizeWorkspace(workspace)

	return readPersistedPromptHistory()
		.filter((entry) => !normalizedWorkspace || !entry.workspace || entry.workspace === normalizedWorkspace)
		.map((entry) => entry.text)
}

export const autosavePromptHistoryDraft = (text: string, workspace?: string): boolean => {
	const normalizedWorkspace = normalizeWorkspace(workspace)

	if (!text.trim()) {
		activeDraftId = null
		return false
	}

	const entries = readPersistedPromptHistory()
	const now = getNow()
	const activeDraftIndex = activeDraftId ? entries.findIndex((entry) => entry.id === activeDraftId) : -1

	if (activeDraftIndex !== -1) {
		const existing = entries[activeDraftIndex]

		if (existing.workspace !== normalizedWorkspace) {
			activeDraftId = null
			return autosavePromptHistoryDraft(text, normalizedWorkspace)
		}

		if (existing.text === text && existing.source === "draft") {
			return false
		}

		entries[activeDraftIndex] = {
			...existing,
			text,
			updatedAt: now,
			source: "draft",
			workspace: normalizedWorkspace,
		}

		return writePersistedPromptHistory(entries)
	}

	const entry: PersistedPromptHistoryEntry = {
		id: createId(),
		text,
		createdAt: now,
		updatedAt: now,
		source: "draft",
		workspace: normalizedWorkspace,
	}

	activeDraftId = entry.id
	return writePersistedPromptHistory([entry, ...entries])
}

export const recordPromptHistorySend = (text: string, workspace?: string): boolean => {
	const trimmedText = text.trim()
	const normalizedWorkspace = normalizeWorkspace(workspace)

	if (!trimmedText) {
		activeDraftId = null
		return false
	}

	const entries = readPersistedPromptHistory()
	const now = getNow()

	activeDraftId = null

	const entry: PersistedPromptHistoryEntry = {
		id: createId(),
		text: trimmedText,
		createdAt: now,
		updatedAt: now,
		source: "sent",
		workspace: normalizedWorkspace,
	}

	return writePersistedPromptHistory([entry, ...entries])
}

export const resetActivePromptHistoryDraft = () => {
	activeDraftId = null
}
