import type { WebviewDiagnosticsSnapshot } from "@roo-code/types"

import { vscode } from "./vscode"

const VSCODE_CSS_VARIABLES = [
	"--vscode-foreground",
	"--vscode-editor-background",
	"--vscode-editor-foreground",
	"--vscode-sideBar-background",
	"--vscode-sideBar-foreground",
] as const

type DiagnosticsErrorSource = "errorBoundary" | "windowError" | "unhandledRejection"
type DiagnosticsSnapshot = WebviewDiagnosticsSnapshot & { didHydrateState: boolean }

const diagnosticsState = {
	didHydrateState: false,
	lastReceivedStateSequence: undefined as number | undefined,
	lastAppliedStateSequence: undefined as number | undefined,
	staleStateRejectionCount: 0,
	unknownMessageUpdateCount: 0,
	activeView: undefined as string | undefined,
	error: undefined as WebviewDiagnosticsSnapshot["error"],
}

const fingerprint = (value: string): string => {
	let hash = 2166136261
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 16777619)
	}
	return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

const getErrorName = (error: unknown): string => {
	if (!(error instanceof Error)) {
		return "UnknownError"
	}

	const name = error.name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)
	return name || "Error"
}

const getErrorFingerprintSource = (source: DiagnosticsErrorSource, error: unknown): string => {
	if (error instanceof Error) {
		const message = error.message.slice(0, 1_000).replace(/(?:[A-Za-z]:\\|\\\\|\/)\S+/g, "[path]")
		return `${source}:${error.name}:${message}`
	}
	return `${source}:${typeof error}`
}

export const recordDiagnosticsHydration = (didHydrateState: boolean) => {
	diagnosticsState.didHydrateState = didHydrateState
}

export const recordDiagnosticsStateSequence = (sequence: unknown, hasMessages: boolean) => {
	if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
		return
	}

	diagnosticsState.lastReceivedStateSequence = sequence
	if (!hasMessages) {
		return
	}

	if (
		diagnosticsState.lastAppliedStateSequence !== undefined &&
		sequence <= diagnosticsState.lastAppliedStateSequence
	) {
		diagnosticsState.staleStateRejectionCount = Math.min(
			diagnosticsState.staleStateRejectionCount + 1,
			Number.MAX_SAFE_INTEGER,
		)
		return
	}

	diagnosticsState.lastAppliedStateSequence = sequence
}

export const recordDiagnosticsUnknownMessageUpdate = () => {
	diagnosticsState.unknownMessageUpdateCount = Math.min(
		diagnosticsState.unknownMessageUpdateCount + 1,
		Number.MAX_SAFE_INTEGER,
	)
}

export const recordDiagnosticsActiveTab = (activeView: string) => {
	diagnosticsState.activeView = activeView
}

export const recordDiagnosticsError = (source: DiagnosticsErrorSource, error: unknown) => {
	try {
		diagnosticsState.error = {
			name: getErrorName(error),
			fingerprint: fingerprint(getErrorFingerprintSource(source, error)),
		}
	} catch {
		diagnosticsState.error = {
			name: "UnknownError",
			fingerprint: fingerprint(`${source}:unavailable`),
		}
	}
}

const readDocumentSnapshot = (): Pick<
	WebviewDiagnosticsSnapshot,
	"documentReadyState" | "documentVisibilityState" | "rootMounted" | "rootChildCount"
> => {
	if (typeof document === "undefined") {
		return {}
	}

	try {
		const root = document.getElementById("root")
		return {
			documentReadyState: document.readyState,
			documentVisibilityState: document.visibilityState,
			rootMounted: root?.hasChildNodes() ?? false,
			rootChildCount: root?.childElementCount ?? 0,
		}
	} catch {
		return {}
	}
}

const readViewportSnapshot = (): WebviewDiagnosticsSnapshot["viewport"] => {
	if (typeof window === "undefined") {
		return undefined
	}

	const { innerWidth, innerHeight, devicePixelRatio } = window
	if (![innerWidth, innerHeight, devicePixelRatio].every(Number.isFinite)) {
		return undefined
	}

	return { width: innerWidth, height: innerHeight, devicePixelRatio }
}

const readThemeSnapshot = (): WebviewDiagnosticsSnapshot["theme"] => {
	if (typeof window === "undefined" || typeof document === "undefined") {
		return undefined
	}

	try {
		const bodyStyle = window.getComputedStyle(document.body)
		const rootStyle = window.getComputedStyle(document.documentElement)
		const variables = Object.fromEntries(
			VSCODE_CSS_VARIABLES.map((name) => [name, rootStyle.getPropertyValue(name).trim()]).filter(
				(entry) => entry[1] !== "",
			),
		)

		return {
			bodyForeground: bodyStyle.color || undefined,
			bodyBackground: bodyStyle.backgroundColor || undefined,
			rootForeground: rootStyle.color || undefined,
			rootBackground: rootStyle.backgroundColor || undefined,
			variables,
		}
	} catch {
		return undefined
	}
}

export const createWebviewDiagnosticsSnapshot = (): DiagnosticsSnapshot => ({
	capturedAt: new Date().toISOString(),
	didHydrateState: diagnosticsState.didHydrateState,
	...readDocumentSnapshot(),
	activeView: diagnosticsState.activeView,
	lastReceivedStateSequence: diagnosticsState.lastReceivedStateSequence,
	lastAppliedStateSequence: diagnosticsState.lastAppliedStateSequence,
	staleStateRejectionCount: diagnosticsState.staleStateRejectionCount,
	unknownMessageUpdateCount: diagnosticsState.unknownMessageUpdateCount,
	viewport: readViewportSnapshot(),
	theme: readThemeSnapshot(),
	error: diagnosticsState.error ? { ...diagnosticsState.error } : undefined,
})

const isDiagnosticsRequest = (value: unknown): value is { type: "diagnosticsRequest"; requestId: string } => {
	if (typeof value !== "object" || value === null) {
		return false
	}

	const message = value as Record<string, unknown>
	return (
		message.type === "diagnosticsRequest" && typeof message.requestId === "string" && message.requestId.length > 0
	)
}

let installedWindow: Window | undefined

export const installWebviewDiagnostics = () => {
	if (typeof window === "undefined" || installedWindow === window) {
		return
	}

	installedWindow = window

	window.addEventListener("message", (event) => {
		if (!isDiagnosticsRequest(event.data)) {
			return
		}

		try {
			vscode.postMessage({
				type: "diagnosticsResponse",
				requestId: event.data.requestId,
				diagnostics: createWebviewDiagnosticsSnapshot(),
			})
		} catch {
			// Diagnostics must never destabilize an already unhealthy webview.
		}
	})

	window.addEventListener("error", (event) => {
		recordDiagnosticsError("windowError", event.error ?? event.message)
	})

	window.addEventListener("unhandledrejection", (event) => {
		recordDiagnosticsError("unhandledRejection", event.reason)
	})
}
