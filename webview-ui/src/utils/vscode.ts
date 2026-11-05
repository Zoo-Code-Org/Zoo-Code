import type { WebviewApi } from "vscode-webview"

import { WebviewMessage } from "@roo/WebviewMessage"

/**
 * A utility wrapper around the acquireVsCodeApi() function, which enables
 * message passing and state management between the webview and extension
 * contexts.
 *
 * This utility also enables webview code to be run in a web browser-based
 * dev server by using native web browser features that mock the functionality
 * enabled by acquireVsCodeApi.
 */
export class VSCodeAPIWrapper {
	private readonly vsCodeApi: WebviewApi<unknown> | undefined
	private fallbackState: unknown | undefined
	// Once a persistent-storage write fails (setItem throws or is unavailable),
	// the persisted JSON is stale: the in-memory fallbackState is authoritative
	// for getState() until a write succeeds again.
	private storageWriteFailed: boolean = false

	// The extension host caps a persisted view id at 64 characters: ClineProvider declares
	// MAX_VIEW_STATE_ID_LENGTH = 64 and refuses a longer value with the "Ignoring an oversized
	// viewStateId" log instead of storing it, so a longer value cannot become this view's id.
	// The host keeps its own copy private and the webview cannot import it, so the number is
	// restated here; vscode.spec.ts pins both the limit and the reuse of the largest legal id.
	public static readonly MAX_VIEW_STATE_ID_LENGTH = 64

	constructor() {
		// Check if the acquireVsCodeApi function exists in the current development
		// context (i.e. VS Code development window or web browser)
		if (typeof acquireVsCodeApi === "function") {
			this.vsCodeApi = acquireVsCodeApi()
		}
	}

	/**
	 * Generates a unique identifier for this webview instance.
	 *
	 * @remarks Used only when no persisted identifier exists yet.
	 */
	private createViewStateId(): string {
		if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
			return crypto.randomUUID()
		}

		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	}

	/**
	 * Returns the stable view state identifier for this webview, creating and persisting
	 * one on first use so the extension can keep per-view state isolated across providers.
	 */
	public getViewStateId(): string {
		const currentState = this.getState()
		const stateObject =
			currentState && typeof currentState === "object" && !Array.isArray(currentState)
				? (currentState as Record<string, unknown>)
				: {}
		const existingViewStateId = stateObject.viewStateId

		// Match the extension host's setViewStateId so this view never registers an id the
		// extension would refuse: same trim and same unsafe-character replacement, drop
		// whitespace-only values, and refuse an id over MAX_VIEW_STATE_ID_LENGTH, which the
		// host logs and refuses without storing (ClineProvider.ts:945-947). The host rejects
		// only "__proto__" by name (ClineProvider.ts:938) while this side refuses every
		// Object.prototype member - deliberately stricter, not a mirror: those names are
		// useless keys here because writing them into the state object goes through the
		// prototype setter and the later spread drops them. The length cap is the mirror.
		const normalizedViewStateId =
			typeof existingViewStateId === "string" ? existingViewStateId.trim().replace(/[^A-Za-z0-9_-]/g, "_") : ""

		if (
			normalizedViewStateId &&
			normalizedViewStateId.length <= VSCodeAPIWrapper.MAX_VIEW_STATE_ID_LENGTH &&
			!Object.prototype.hasOwnProperty.call(Object.prototype, normalizedViewStateId)
		) {
			return normalizedViewStateId
		}

		const viewStateId = this.createViewStateId()
		this.setState({ ...stateObject, viewStateId })
		return viewStateId
	}

	/**
	 * Post a message (i.e. send arbitrary data) to the owner of the webview.
	 *
	 * @remarks When running webview code inside a web browser, postMessage will instead
	 * log the given message to the console.
	 *
	 * @param message Arbitrary data (must be JSON serializable) to send to the extension context.
	 */
	public postMessage(message: WebviewMessage) {
		if (this.vsCodeApi) {
			this.vsCodeApi.postMessage(message)
		} else {
			console.log(message)
		}
	}

	/**
	 * Get the persistent state stored for this webview.
	 *
	 * @remarks When running webview source code inside a web browser, getState will retrieve state
	 * from local storage (https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).
	 *
	 * @return The current state or `undefined` if no state has been set.
	 */
	public getState(): unknown | undefined {
		if (this.vsCodeApi) {
			return this.vsCodeApi.getState()
		}

		if (this.storageWriteFailed) {
			// A previous write could not be persisted: reading localStorage would
			// return stale JSON, so the in-memory fallback is authoritative.
			return this.fallbackState
		}

		try {
			if (typeof localStorage?.getItem === "function") {
				const state = localStorage.getItem("vscodeState")
				return state ? JSON.parse(state) : this.fallbackState
			}
		} catch {
			return this.fallbackState
		}

		return this.fallbackState
	}

	/**
	 * Set the persistent state stored for this webview.
	 *
	 * @remarks When running webview source code inside a web browser, setState will set the given
	 * state using local storage (https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).
	 *
	 * @param newState New persisted state. This must be a JSON serializable object. Can be retrieved
	 * using {@link getState}.
	 *
	 * @return The new state.
	 */
	public setState<T extends unknown | undefined>(newState: T): T {
		if (this.vsCodeApi) {
			return this.vsCodeApi.setState(newState)
		}

		this.fallbackState = newState

		try {
			if (typeof localStorage?.setItem === "function") {
				localStorage.setItem("vscodeState", JSON.stringify(newState))
				this.storageWriteFailed = false
			} else {
				this.storageWriteFailed = true
			}
		} catch {
			// Storage can be unavailable in restricted webview/browser contexts.
			// The in-memory fallback above keeps a stable viewStateId for this session.
			this.storageWriteFailed = true
		}

		return newState
	}
}

// Exports class singleton to prevent multiple invocations of acquireVsCodeApi.
export const vscode = new VSCodeAPIWrapper()
