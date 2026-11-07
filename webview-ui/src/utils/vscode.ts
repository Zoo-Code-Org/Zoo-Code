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
		// Presence is not enough: a crypto object can inherit a randomUUID property that is
		// undefined or not a function, and calling it would throw before any id is minted.
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
			return crypto.randomUUID()
		}

		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	}

	// The host enforces the same bound (ClineProvider.MAX_VIEW_STATE_ID_LENGTH) when it accepts
	// this id, and it enforces it on every launch, so the webview must not hand it a longer one.
	private static readonly MAX_VIEW_STATE_ID_LENGTH = 64

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

		// Keep this one an id the extension will accept. ClineProvider.setViewStateId trims and
		// rewrites unsafe characters exactly as the line below does, and then rejects only two
		// things: an empty result and the "__proto__" key. So "constructor" and "toString" are
		// accepted by the host, and this side is deliberately stricter - it refuses every
		// Object.prototype name, because writing states["constructor"] hits an inherited key that a
		// later spread can drop. The host also refuses ids longer than MAX_VIEW_STATE_ID_LENGTH,
		// which is applied here too: a stored id above that bound would be rejected on every
		// launch, which is exactly the stranding of this view pre-launch entry this guard exists to
		// avoid. Being stricter than the peer is the point - the webview must never register an id
		// the host will not take.
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
