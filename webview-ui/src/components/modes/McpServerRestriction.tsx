import React, { useState, useEffect, useRef, useCallback } from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import type { ModeConfig, McpServer } from "@roo-code/types"
import McpServerChecklist from "./McpServerChecklist"

export interface McpServerRestrictionProps {
	customMode: ModeConfig
	mcpServers: McpServer[]
	onCommit: (slug: string, updates: ModeConfig) => void
}

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
 * Uses a local cached-state buffer + 150 ms debounced flush to avoid host
 * round-trip flicker on toggle and per-server checkbox interactions.
 */
const McpServerRestriction: React.FC<McpServerRestrictionProps> = ({ customMode, mcpServers, onCommit }) => {
	const [cachedAllowedMcpServers, setCachedAllowedMcpServers] = useState<string[] | undefined>(
		customMode.allowedMcpServers,
	)

	const lastFlushedRef = useRef<string[] | undefined>(customMode.allowedMcpServers)
	const isInitialMountRef = useRef(true)
	const lastSlugRef = useRef(customMode.slug)

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

	// External-edit reconciliation: same slug, prop changed and NOT our own flush.
	useEffect(() => {
		if (lastSlugRef.current !== customMode.slug) return
		if (arraysEqualOrBothUndefined(customMode.allowedMcpServers, cachedAllowedMcpServers)) return
		if (arraysEqualOrBothUndefined(customMode.allowedMcpServers, lastFlushedRef.current)) return
		setCachedAllowedMcpServers(customMode.allowedMcpServers)
		lastFlushedRef.current = customMode.allowedMcpServers
		isInitialMountRef.current = true
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [customMode.allowedMcpServers, customMode.slug])

	// Debounced flush to host.
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
			const latestCustomMode = latestCustomModeRef.current
			latestOnCommitRef.current(latestCustomMode.slug, {
				...latestCustomMode,
				allowedMcpServers: cachedAllowedMcpServers,
				source: latestCustomMode.source || "global",
			})
		}, 150)
		return () => clearTimeout(handle)
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
