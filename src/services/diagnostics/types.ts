import type { HistoryItem, WebviewDiagnosticsSnapshot } from "@roo-code/types"

export type DiagnosticsEventPhase = "start" | "success" | "failure"

export interface DiagnosticsStructuralEvent {
	timestamp: string
	boundary: "provider" | "webview-in" | "webview-out" | "task-history" | "task-navigation"
	phase: DiagnosticsEventPhase
	type?: string
	action?: string
	elapsedMs?: number
	stateSequence?: number
	taskId?: string
	messageCount?: number
}

export interface DiagnosticsProviderSourceSnapshot {
	renderContext: "sidebar" | "editor"
	disposed: boolean
	viewPresent: boolean
	visible: boolean
	launched: boolean
	taskHistoryInitialized: boolean
	taskCount: number
	currentTaskId?: string
	currentMessageCount: number
	currentTodoCount: number
	history: HistoryItem[]
	events: DiagnosticsStructuralEvent[]
	eventsTruncated: boolean
}

export interface DiagnosticsProviderSource {
	getDiagnosticsSnapshot(): DiagnosticsProviderSourceSnapshot
	requestWebviewDiagnostics(timeoutMs?: number): Promise<WebviewDiagnosticsSnapshot | undefined>
}

export interface DiagnosticsReportV1 {
	schemaVersion: 1
	capturedAt: string
	privacy: {
		conversationContentIncluded: false
		uploaded: false
		excluded: string[]
	}
	extension: {
		version: string
		releaseChannel: string
	}
	environment: {
		vscodeVersion: string
		appName: string
		uiKind: "desktop" | "web" | "unknown"
		platform: string
		architecture: string
		locale: string
		remote: boolean
		workspaceFolderCount: number
		customStorageConfigured: boolean
		colorThemeKind: "light" | "dark" | "highContrast" | "highContrastLight" | "unknown"
	}
	providers: DiagnosticsProviderReport[]
	persistence: DiagnosticsPersistenceReport
	collectionErrors: string[]
}

export interface DiagnosticsProviderReport {
	instance: number
	renderContext: "sidebar" | "editor"
	disposed: boolean
	viewPresent: boolean
	visible: boolean
	launched: boolean
	taskHistoryInitialized: boolean
	taskCount: number
	currentTask?: string
	currentMessageCount: number
	currentTodoCount: number
	events: Array<Omit<DiagnosticsStructuralEvent, "taskId"> & { task?: string }>
	eventsTruncated: boolean
	webviewResponse: "received" | "unavailable"
	webview?: Record<string, unknown>
}

export interface DiagnosticsFileInspection {
	exists: boolean
	size?: number
	parseStatus?: "valid" | "invalid" | "tooLargeToInspect" | "unavailable"
	topLevelShape?: "array" | "object" | "other"
}

export interface DiagnosticsPersistenceReport {
	cacheEntryCount: number
	index: DiagnosticsFileInspection & {
		version?: number
		entryCount?: number
		relevantEntriesPresent?: number
		cacheCountMatches?: boolean
	}
	tasks: Array<{
		id: string
		rootTask?: string
		parentTask?: string
		children: string[]
		status?: HistoryItem["status"]
		number?: number
		historyItem: DiagnosticsFileInspection
		uiMessages: DiagnosticsFileInspection & {
			messageCount?: number
			firstTimestamp?: number
			lastTimestamp?: number
		}
		integrityFindings: string[]
	}>
}
