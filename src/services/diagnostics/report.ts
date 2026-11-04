import { createHash, randomBytes } from "crypto"

import type { HistoryItem, WebviewDiagnosticsSnapshot } from "@roo-code/types"

import { collectPersistenceDiagnostics } from "./persistence"
import type {
	DiagnosticsProviderReport,
	DiagnosticsProviderSource,
	DiagnosticsProviderSourceSnapshot,
	DiagnosticsReportV1,
} from "./types"

const WEBVIEW_TIMEOUT_MS = 1_000
const MAX_STRING_LENGTH = 120
const ALLOWED_THEME_VARIABLES = new Set([
	"--vscode-foreground",
	"--vscode-editor-background",
	"--vscode-editor-foreground",
	"--vscode-sideBar-background",
	"--vscode-sideBar-foreground",
])

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => resolve(undefined), timeoutMs)
		void operation.then(
			(value) => {
				clearTimeout(timeout)
				resolve(value)
			},
			() => {
				clearTimeout(timeout)
				resolve(undefined)
			},
		)
	})
}

function safeToken(value: unknown, maxLength = MAX_STRING_LENGTH): string | undefined {
	if (typeof value !== "string") return undefined
	const trimmed = value.slice(0, maxLength)
	return /^[\w .#(),%:/-]*$/.test(trimmed) && !trimmed.includes("://") ? trimmed : undefined
}

function safeCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function sanitizeWebviewDiagnostics(
	snapshot: WebviewDiagnosticsSnapshot,
	pseudonymize: (value: string) => string,
): Record<string, unknown> {
	const variables = Object.fromEntries(
		Object.entries(snapshot.theme?.variables ?? {})
			.filter(([key]) => ALLOWED_THEME_VARIABLES.has(key))
			.map(([key, value]) => [key, safeToken(value, 64)])
			.filter((entry): entry is [string, string] => entry[1] !== undefined),
	)
	return {
		capturedAt: safeToken(snapshot.capturedAt),
		didHydrateState: typeof snapshot.didHydrateState === "boolean" ? snapshot.didHydrateState : undefined,
		documentReadyState: safeToken(snapshot.documentReadyState),
		documentVisibilityState: safeToken(snapshot.documentVisibilityState),
		activeView: safeToken(snapshot.activeView, 40),
		rootMounted: typeof snapshot.rootMounted === "boolean" ? snapshot.rootMounted : undefined,
		rootChildCount: safeCount(snapshot.rootChildCount),
		lastReceivedStateSequence: safeCount(snapshot.lastReceivedStateSequence),
		lastAppliedStateSequence: safeCount(snapshot.lastAppliedStateSequence),
		staleStateRejectionCount: safeCount(snapshot.staleStateRejectionCount),
		unknownMessageUpdateCount: safeCount(snapshot.unknownMessageUpdateCount),
		currentTask: snapshot.currentTaskId ? pseudonymize(snapshot.currentTaskId) : undefined,
		chatMessageCount: safeCount(snapshot.chatMessageCount),
		historyItemCount: safeCount(snapshot.historyItemCount),
		todoCount: safeCount(snapshot.todoCount),
		viewport: snapshot.viewport
			? {
					width: safeCount(snapshot.viewport.width),
					height: safeCount(snapshot.viewport.height),
					devicePixelRatio: safeCount(snapshot.viewport.devicePixelRatio),
				}
			: undefined,
		theme: snapshot.theme
			? {
					kind: safeCount(snapshot.theme.kind),
					identifier: safeToken(snapshot.theme.identifier, 80),
					bodyForeground: safeToken(snapshot.theme.bodyForeground, 64),
					bodyBackground: safeToken(snapshot.theme.bodyBackground, 64),
					rootForeground: safeToken(snapshot.theme.rootForeground, 64),
					rootBackground: safeToken(snapshot.theme.rootBackground, 64),
					variables,
				}
			: undefined,
		error: snapshot.error
			? {
					name: safeToken(snapshot.error.name, 40),
					fingerprint: safeToken(snapshot.error.fingerprint, 128),
				}
			: undefined,
	}
}

function mergeHistory(snapshots: DiagnosticsProviderSourceSnapshot[]): HistoryItem[] {
	const byId = new Map<string, HistoryItem>()
	for (const snapshot of snapshots) {
		for (const item of snapshot.history) byId.set(item.id, item)
	}
	return Array.from(byId.values()).sort((a, b) => b.ts - a.ts)
}

export async function buildDiagnosticsReport(options: {
	providers: DiagnosticsProviderSource[]
	storagePath: string
	version: string
	releaseChannel: string
	environment: DiagnosticsReportV1["environment"]
}): Promise<DiagnosticsReportV1> {
	const salt = randomBytes(32)
	const pseudonymize = (value: string) =>
		`task-${createHash("sha256").update(salt).update(value).digest("hex").slice(0, 12)}`
	const collectionErrors: string[] = []
	const snapshots = options.providers.map((provider, index) => {
		try {
			return provider.getDiagnosticsSnapshot()
		} catch {
			collectionErrors.push(`provider-${index + 1}:snapshot-failed`)
			return {
				renderContext: "sidebar" as const,
				disposed: false,
				viewPresent: false,
				visible: false,
				launched: false,
				taskHistoryInitialized: false,
				taskCount: 0,
				currentMessageCount: 0,
				currentTodoCount: 0,
				history: [],
				events: [],
				eventsTruncated: false,
			}
		}
	})

	const providerReports: DiagnosticsProviderReport[] = await Promise.all(
		options.providers.map(async (provider, index) => {
			const snapshot = snapshots[index]
			const webview = await withTimeout(
				provider.requestWebviewDiagnostics(WEBVIEW_TIMEOUT_MS),
				WEBVIEW_TIMEOUT_MS + 100,
			)
			if (!webview && snapshot.viewPresent) collectionErrors.push(`provider-${index + 1}:webview-unavailable`)
			return {
				instance: index + 1,
				renderContext: snapshot.renderContext,
				disposed: snapshot.disposed,
				viewPresent: snapshot.viewPresent,
				visible: snapshot.visible,
				launched: snapshot.launched,
				taskHistoryInitialized: snapshot.taskHistoryInitialized,
				taskCount: snapshot.taskCount,
				currentTask: snapshot.currentTaskId ? pseudonymize(snapshot.currentTaskId) : undefined,
				currentMessageCount: snapshot.currentMessageCount,
				currentTodoCount: snapshot.currentTodoCount,
				events: snapshot.events.slice(-100).map((event) => ({
					timestamp: safeToken(event.timestamp, 40) ?? "invalid",
					boundary: event.boundary,
					phase: event.phase,
					type: safeToken(event.type, 80),
					action: safeToken(event.action, 80),
					elapsedMs: safeCount(event.elapsedMs),
					stateSequence: safeCount(event.stateSequence),
					messageCount: safeCount(event.messageCount),
					task: event.taskId ? pseudonymize(event.taskId) : undefined,
				})),
				eventsTruncated: snapshot.eventsTruncated || snapshot.events.length > 100,
				webviewResponse: webview ? "received" : "unavailable",
				webview: webview ? sanitizeWebviewDiagnostics(webview, pseudonymize) : undefined,
			}
		}),
	)

	let persistence: DiagnosticsReportV1["persistence"]
	try {
		persistence = await collectPersistenceDiagnostics({
			storagePath: options.storagePath,
			history: mergeHistory(snapshots),
			currentTaskIds: snapshots.flatMap((snapshot) => [
				...(snapshot.currentTaskId ? [snapshot.currentTaskId] : []),
				...snapshot.events
					.filter((event) => event.boundary === "task-navigation" && event.taskId)
					.map((event) => event.taskId!),
			]),
			pseudonymize,
		})
	} catch {
		collectionErrors.push("persistence:collection-failed")
		persistence = { cacheEntryCount: 0, index: { exists: false, parseStatus: "unavailable" }, tasks: [] }
	}

	return {
		schemaVersion: 1,
		capturedAt: new Date().toISOString(),
		privacy: {
			conversationContentIncluded: false,
			uploaded: false,
			excluded: [
				"conversation content",
				"task titles and tool payloads",
				"API history and settings values",
				"secrets, tokens, and identity",
				"machine identifiers and hostnames",
				"workspace paths and repository details",
				"raw task and workspace identifiers",
				"raw logs",
			],
		},
		extension: { version: options.version, releaseChannel: options.releaseChannel },
		environment: options.environment,
		providers: providerReports,
		persistence,
		collectionErrors,
	}
}
