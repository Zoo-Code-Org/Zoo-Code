import * as fs from "fs/promises"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import type { DiagnosticsFileInspection, DiagnosticsPersistenceReport } from "./types"

const MAX_TASKS = 10
const MAX_INSPECTION_BYTES = 25 * 1024 * 1024
const FILE_TIMEOUT_MS = 500

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs)
		void operation.then(
			(value) => {
				clearTimeout(timeout)
				resolve(value)
			},
			(error) => {
				clearTimeout(timeout)
				reject(error)
			},
		)
	})
}

function getShape(value: unknown): DiagnosticsFileInspection["topLevelShape"] {
	if (Array.isArray(value)) return "array"
	if (value !== null && typeof value === "object") return "object"
	return "other"
}

async function inspectJson(filePath: string): Promise<{ inspection: DiagnosticsFileInspection; value?: unknown }> {
	try {
		const stat = await withTimeout(fs.stat(filePath), FILE_TIMEOUT_MS)
		if (stat.size > MAX_INSPECTION_BYTES) {
			return { inspection: { exists: true, size: stat.size, parseStatus: "tooLargeToInspect" } }
		}
		const raw = await withTimeout(fs.readFile(filePath, "utf8"), FILE_TIMEOUT_MS)
		try {
			const value: unknown = JSON.parse(raw)
			return {
				inspection: { exists: true, size: stat.size, parseStatus: "valid", topLevelShape: getShape(value) },
				value,
			}
		} catch {
			return { inspection: { exists: true, size: stat.size, parseStatus: "invalid" } }
		}
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { inspection: { exists: false } }
		}
		return { inspection: { exists: false, parseStatus: "unavailable" } }
	}
}

function isHistoryItem(value: unknown): value is HistoryItem {
	return value !== null && typeof value === "object" && "id" in value && typeof value.id === "string"
}

function isSafeTaskId(value: string): boolean {
	return /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function hasParentCycle(item: HistoryItem, byId: Map<string, HistoryItem>): boolean {
	const visited = new Set<string>()
	let current: HistoryItem | undefined = item
	while (current) {
		if (visited.has(current.id)) return true
		visited.add(current.id)
		current = current.parentTaskId ? byId.get(current.parentTaskId) : undefined
	}
	return false
}

function selectRelevant(history: HistoryItem[], currentIds: string[]): HistoryItem[] {
	const byId = new Map(history.map((item) => [item.id, item]))
	const selected = new Set<string>()
	const queue = [...currentIds]
	if (queue.length === 0 && history[0]) queue.push(history[0].id)

	while (queue.length > 0 && selected.size < MAX_TASKS) {
		const id = queue.shift()
		if (!id || selected.has(id)) continue
		selected.add(id)
		const item = byId.get(id)
		if (!item) continue
		for (const related of [item.rootTaskId, item.parentTaskId, item.awaitingChildId, ...(item.childIds ?? [])]) {
			if (related && !selected.has(related)) queue.push(related)
		}
	}

	return Array.from(selected, (id) => byId.get(id)).filter(
		(item): item is HistoryItem => item !== undefined && isSafeTaskId(item.id),
	)
}

export async function collectPersistenceDiagnostics(options: {
	storagePath: string
	history: HistoryItem[]
	currentTaskIds: string[]
	pseudonymize: (value: string) => string
}): Promise<DiagnosticsPersistenceReport> {
	const { storagePath, history, currentTaskIds, pseudonymize } = options
	const tasksPath = path.join(storagePath, "tasks")
	const relevant = selectRelevant(history, currentTaskIds)
	const relevantIds = new Set(relevant.map((item) => item.id))
	const byId = new Map(history.map((item) => [item.id, item]))
	const indexResult = await inspectJson(path.join(tasksPath, GlobalFileNames.historyIndex))

	let indexEntries: unknown[] | undefined
	let indexVersion: number | undefined
	if (indexResult.value !== null && typeof indexResult.value === "object" && !Array.isArray(indexResult.value)) {
		const value = indexResult.value as Record<string, unknown>
		indexVersion = typeof value.version === "number" ? value.version : undefined
		indexEntries = Array.isArray(value.entries) ? value.entries : undefined
	}
	const indexIds = new Set(indexEntries?.filter(isHistoryItem).map((item) => item.id) ?? [])

	const tasks = await Promise.all(
		relevant.map(async (item) => {
			const taskPath = path.join(tasksPath, item.id)
			const [historyItemResult, uiMessagesResult] = await Promise.all([
				inspectJson(path.join(taskPath, GlobalFileNames.historyItem)),
				inspectJson(path.join(taskPath, GlobalFileNames.uiMessages)),
			])
			const messages = Array.isArray(uiMessagesResult.value) ? uiMessagesResult.value : undefined
			const timestamps = (messages ?? [])
				.map((message) =>
					message !== null && typeof message === "object" && "ts" in message && typeof message.ts === "number"
						? message.ts
						: undefined,
				)
				.filter((timestamp): timestamp is number => timestamp !== undefined)
			const findings: string[] = []
			for (const related of [
				item.rootTaskId,
				item.parentTaskId,
				item.awaitingChildId,
				...(item.childIds ?? []),
			]) {
				if (related && !byId.has(related)) findings.push("missingReferencedTask")
			}
			if (item.awaitingChildId && item.status !== "delegated") findings.push("awaitingChildStatusMismatch")
			if (item.parentTaskId && !byId.get(item.parentTaskId)?.childIds?.includes(item.id)) {
				findings.push("parentChildMismatch")
			}
			if (hasParentCycle(item, byId)) findings.push("parentCycle")

			return {
				id: pseudonymize(item.id),
				rootTask: item.rootTaskId ? pseudonymize(item.rootTaskId) : undefined,
				parentTask: item.parentTaskId ? pseudonymize(item.parentTaskId) : undefined,
				children: (item.childIds ?? []).slice(0, MAX_TASKS).map(pseudonymize),
				status: item.status,
				number: item.number,
				historyItem: historyItemResult.inspection,
				uiMessages: {
					...uiMessagesResult.inspection,
					messageCount: messages?.length,
					firstTimestamp: timestamps[0],
					lastTimestamp: timestamps.at(-1),
				},
				integrityFindings: Array.from(new Set(findings)),
			}
		}),
	)

	return {
		cacheEntryCount: history.length,
		index: {
			...indexResult.inspection,
			version: indexVersion,
			entryCount: indexEntries?.length,
			relevantEntriesPresent: Array.from(relevantIds).filter((id) => indexIds.has(id)).length,
			cacheCountMatches: indexEntries ? indexEntries.length === history.length : undefined,
		},
		tasks,
	}
}
