import React, { useState, useEffect, useRef, useCallback } from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import type { ModeConfig, McpServer } from "@roo-code/types"
import McpServerChecklist from "./McpServerChecklist"

export interface McpServerRestrictionProps {
	customMode: ModeConfig
	mcpServers: McpServer[]
	onCommit: (slug: string, updates: ModeConfig) => void
}

/**
 * Returns true when both inputs are undefined OR both are arrays containing
 * the same set of strings (order-insensitive). This is the equality predicate
 * used to decide whether the local cached state and the host-side
 * `customMode.allowedMcpServers` are already in sync, so we can skip
 * redundant `updateCustomMode` postMessages and external-edit overwrites.
 */
function arraysEqualOrBothUndefined(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true
	if (a === undefined || b === undefined) return false
	if (a.length !== b.length) return false
	const aSorted = [...a].sort()
	const bSorted = [...b].sort()
	for (let i = 0; i < aSorted.length; i++) {
		if (aSorted[i] !== bSorted[i]) return false
	}
	return true
}

/**
 * Edit-panel UI for the per-mode MCP server restriction list.
 *
 * This component implements the cached-state pattern (see AGENTS.md):
 * inputs bind to a local `cachedAllowedMcpServers` buffer rather than the live
 * `customMode.allowedMcpServers` prop. The buffer is flushed to the host via
 * `onCommit` after a 150 ms debounce. This isolates user edits from the
 * `ContextProxy` host round-trip (~50–250 ms) so the toggle and per-server
 * checkboxes don't snap back / flicker between the click and the host echo,
 * and the conditionally-mounted `mcp-server-list` subtree doesn't unmount
 * mid-interaction.
 *
 * Reconciliation rules:
 *  - When `customMode.slug` changes (mode switch), reseed from props.
 *  - When `customMode.allowedMcpServers` changes externally (i.e. not as a
 *    result of our own most recent flush — tracked via `lastFlushedRef`),
 *    overwrite the cache. This handles the "another window edited the mode"
 *    case without clobbering an in-flight user edit.
 */
const McpServerRestriction: React.FC<McpServerRestrictionProps> = ({ customMode, mcpServers, onCommit }) => {
	const [cachedAllowedMcpServers, setCachedAllowedMcpServers] = useState<string[] | undefined>(
		customMode.allowedMcpServers,
	)

	// Tracks the value we most recently flushed via onCommit, so we can
	// distinguish the host's echo of our own write (ignore) from a true
	// external edit (overwrite cache).
	const lastFlushedRef = useRef<string[] | undefined>(customMode.allowedMcpServers)
	// Skip the very first debounced-flush effect run; it's just the seeding
	// pass and the cache already matches the prop.
	const isInitialMountRef = useRef(true)
	// Reseed-on-mode-switch is keyed on slug; track the last slug we saw.
	const lastSlugRef = useRef(customMode.slug)

	// Always hold the latest `customMode` and `onCommit` so the debounced flush
	// merges `allowedMcpServers` into the freshest mode snapshot instead of the
	// stale one captured when the timeout was scheduled. Without this, an edit to
	// another field of the same mode within the 150 ms debounce window would be
	// clobbered when this flush spreads an outdated `customMode`.
	const latestCustomModeRef = useRef(customMode)
	const latestOnCommitRef = useRef(onCommit)
	useEffect(() => {
		latestCustomModeRef.current = customMode
		latestOnCommitRef.current = onCommit
	})

	// Reseed when the user switches to a different mode.
	useEffect(() => {
		if (lastSlugRef.current !== customMode.slug) {
			lastSlugRef.current = customMode.slug
			setCachedAllowedMcpServers(customMode.allowedMcpServers)
			lastFlushedRef.current = customMode.allowedMcpServers
			isInitialMountRef.current = true
		}
	}, [customMode.slug, customMode.allowedMcpServers])

	// External-edit reconciliation: same slug, but the prop changed AND it's
	// not the echo of our own most recent flush. Overwrite the cache.
	useEffect(() => {
		if (lastSlugRef.current !== customMode.slug) return
		if (arraysEqualOrBothUndefined(customMode.allowedMcpServers, cachedAllowedMcpServers)) return
		if (arraysEqualOrBothUndefined(customMode.allowedMcpServers, lastFlushedRef.current)) return
		// External update — overwrite cache.
		setCachedAllowedMcpServers(customMode.allowedMcpServers)
		lastFlushedRef.current = customMode.allowedMcpServers
		isInitialMountRef.current = true
		// We intentionally only react to changes in customMode.allowedMcpServers/slug;
		// including cachedAllowedMcpServers here would create a feedback loop with
		// the optimistic local updates.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [customMode.allowedMcpServers, customMode.slug])

	// Debounced flush: 150 ms after the last local edit, postMessage to host.
	useEffect(() => {
		if (isInitialMountRef.current) {
			isInitialMountRef.current = false
			return
		}
		if (arraysEqualOrBothUndefined(cachedAllowedMcpServers, customMode.allowedMcpServers)) {
			return
		}
		const handle = setTimeout(() => {
			lastFlushedRef.current = cachedAllowedMcpServers
			// Merge into the freshest mode snapshot (via refs) so a concurrent edit to
			// another field within the debounce window is not clobbered by a stale spread.
			const latestCustomMode = latestCustomModeRef.current
			latestOnCommitRef.current(latestCustomMode.slug, {
				...latestCustomMode,
				allowedMcpServers: cachedAllowedMcpServers,
				source: latestCustomMode.source || "global",
			})
		}, 150)
		return () => clearTimeout(handle)
		// We intentionally exclude `customMode` and `onCommit` from deps: this
		// effect should only fire in response to user edits to the cached value,
		// not whenever the parent re-renders with a new mode object.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cachedAllowedMcpServers])

	const isRestricted = cachedAllowedMcpServers !== undefined

	const handleToggle = useCallback((e: Event | React.FormEvent<HTMLElement>) => {
		const target = (e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
		const checked = target.checked
		setCachedAllowedMcpServers(checked ? [] : undefined)
	}, [])

	const handleServerToggle = useCallback(
		(serverName: string) => (e: Event | React.FormEvent<HTMLElement>) => {
			const target = (e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
			const checked = target.checked
			setCachedAllowedMcpServers((prev) => {
				const current = prev || []
				if (checked) {
					return current.includes(serverName) ? current : [...current, serverName]
				}
				return current.filter((s) => s !== serverName)
			})
		},
		[],
	)

	return (
		<div className="mt-3 ml-1" data-testid="mcp-server-restriction">
			<VSCodeCheckbox checked={isRestricted} data-testid="restrict-mcp-servers-toggle" onChange={handleToggle}>
				Restrict to specific MCP servers
			</VSCodeCheckbox>
			{isRestricted && (
				<McpServerChecklist
					allowedMcpServers={cachedAllowedMcpServers ?? []}
					mcpServers={mcpServers}
					onServerToggle={handleServerToggle}
					testIdPrefix="mcp-server"
				/>
			)}
		</div>
	)
}

export default React.memo(McpServerRestriction)
export { McpServerRestriction as McpServerRestrictionImpl, arraysEqualOrBothUndefined }
