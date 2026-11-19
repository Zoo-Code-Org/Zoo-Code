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

	// The host enforces the same bound in ClineProvider.setViewStateId (its
	// MAX_VIEW_STATE_ID_LENGTH); the webview must not hand back an id the host would refuse.
	private static readonly MAX_VIEW_STATE_ID_LENGTH = 64

	/**
	 * Returns the stable view state identifier for this webview, creating and persisting
	 * one on first use so the extension can keep per-view state isolated across providers.
	 * Follow-up #2226 replaces this client-side validation with a host-minted claim token,
	 * later in the merge order; until that lands this path has to apply the host's bound.
	 */
	public getViewStateId(): string {
		const currentState = this.getState()
		const stateObject =
			currentState && typeof currentState === "object" && !Array.isArray(currentState)
				? (currentState as Record<string, unknown>)
				: {}
		const existingViewStateId = stateObject.viewStateId

		// Mirror the ClineProvider.setViewStateId validation so the webview never
		// registers an id the extension would reject: trim, replace unsafe
		// characters, and drop whitespace-only values plus every Object.prototype
		// member name. "__proto__" alone is not enough: ids like "constructor" or
		// "toString" survive the host's normalization and would be refused there
		// forever, stranding this view's pre-launch entry under the temporary id.
		const normalizedViewStateId =
			typeof existingViewStateId === "string" ? existingViewStateId.trim().replace(/[^A-Za-z0-9_-]/g, "_") : ""

		// A stored value that breaks the host's length bound - an older build, a manual edit,
		// a corrupted state - is one the host logs 'Ignoring an oversized viewStateId' for and
		// refuses on every launch, which would strand this view's pre-launch entry forever. Fall
		// through to a freshly generated id instead of reusing it.
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
