/* v8 ignore file -- Playwright CT module alias, covered by visual tests. */
import React, { createContext, useContext } from "react"

/**
 * Playwright CT alias for `@/context/ExtensionStateContext`.
 *
 * The real `ExtensionStateContextProvider` imports `@roo-code/types`, which
 * pulls Zod into the browser bundle. Zod crashes in the Playwright CT runtime
 * with `ReferenceError: z is not defined`.
 *
 * Only a handful of components (`TabContent`, `DashboardView`, etc.) call
 * `useExtensionState()`, and they only need a stable context object so the
 * "must be used within a provider" throw is avoided. This mock provides
 * exactly that: a minimal, static context value with every setter stubbed to
 * a no-op.
 *
 * NOTE: We intentionally do NOT `import type` from the real
 * `@/context/ExtensionStateContext` module. Some Vite pipelines keep type-only
 * barrel imports alive long enough to traverse the module graph, which would
 * re-introduce the Zod dependency. The mock is structurally typed — the real
 * interface is only needed by callers, who are compiled against the real
 * `.d.ts`, not this runtime module.
 */

const noop = () => {}

// Minimal default state. Only the properties actually read by dashboard
// components need to be present at runtime; the rest are provided so any
// incidental reads return sensible values instead of crashing.
const defaultContextValue = {
	// ── Core state ────────────────────────────────────────────────────────
	didHydrateState: true,
	showWelcome: false,
	theme: "dark",
	mcpServers: [],
	filePaths: [],
	openedTabs: [],
	commands: [],
	organizationAllowList: { allowAll: true, providers: {} },
	organizationSettingsVersion: 0,
	cloudIsAuthenticated: false,
	sharingEnabled: false,
	publicSharingEnabled: false,
	hasOpenedModeSelector: false,
	alwaysAllowFollowupQuestions: false,
	followupAutoApproveTimeoutMs: undefined,
	profileThresholds: {},
	customModes: [],
	maxWorkspaceFiles: 200,
	maxOpenTabsContext: 20,
	cwd: "",
	// renderContext is read by TabContent to decide wheel-scroll behavior.
	renderContext: "sidebar",
} as Record<string, unknown>

// Lazily attach no-op setters on first access. Components destructure many
// `setX` functions from the context; Proxy gives us a stable no-op for any
// key starting with `set` without enumerating them all here.
const setterProxy = new Proxy(defaultContextValue, {
	get(target, prop, receiver) {
		if (typeof prop === "string" && prop.startsWith("set") && !(prop in target)) {
			return noop
		}
		return Reflect.get(target, prop, receiver)
	},
})

const MockExtensionStateContext = createContext<Record<string, unknown>>(setterProxy)

export const ExtensionStateContextProvider: React.FC<{
	children: React.ReactNode
	initialState?: Record<string, unknown>
}> = ({ children, initialState }) => {
	// Merge initialState into a fresh Proxy so `setX` no-ops keep working even
	// when callers override individual state keys. Spreading the Proxy would
	// drop the `get` trap, so build a new Proxy over a merged target instead.
	const value = initialState
		? new Proxy(
				{ ...defaultContextValue, ...initialState },
				{
					get(target, prop, receiver) {
						if (typeof prop === "string" && prop.startsWith("set") && !(prop in target)) {
							return noop
						}
						return Reflect.get(target, prop, receiver)
					},
				},
			)
		: setterProxy
	return <MockExtensionStateContext.Provider value={value}>{children}</MockExtensionStateContext.Provider>
}

export function useExtensionState(): Record<string, unknown> {
	return useContext(MockExtensionStateContext)
}

export function mergeExtensionState(
	prevState: Record<string, unknown>,
	newState: Record<string, unknown>,
): Record<string, unknown> {
	return { ...prevState, ...newState }
}
