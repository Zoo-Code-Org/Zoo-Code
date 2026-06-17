import React from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import type { McpServer } from "@roo-code/types"

export interface McpServerChecklistProps {
	/** The currently-allowed server names. */
	allowedMcpServers: string[]
	/** All currently-connected MCP servers. */
	mcpServers: McpServer[]
	/** Toggle handler for a given server name. */
	onServerToggle: (serverName: string) => (e: Event | React.FormEvent<HTMLElement>) => void
	/**
	 * Prefix for the rendered `data-testid` attributes. The list container is
	 * `${testIdPrefix}-list` and each checkbox is `${testIdPrefix}-checkbox-${name}`.
	 */
	testIdPrefix: string
}

const McpServerChecklist: React.FC<McpServerChecklistProps> = ({
	allowedMcpServers,
	mcpServers,
	onServerToggle,
	testIdPrefix,
}) => {
	return (
		<div className="ml-6 mt-2 flex flex-col gap-1" data-testid={`${testIdPrefix}-list`}>
			{mcpServers && mcpServers.length > 0 ? (
				mcpServers.map((server) => (
					<VSCodeCheckbox
						key={server.name}
						checked={allowedMcpServers.includes(server.name)}
						data-testid={`${testIdPrefix}-checkbox-${server.name}`}
						onChange={onServerToggle(server.name)}>
						{server.name}
					</VSCodeCheckbox>
				))
			) : (
				<div className="text-xs text-vscode-descriptionForeground">No MCP servers connected</div>
			)}
			{allowedMcpServers
				.filter((s) => !mcpServers?.some((ms) => ms.name === s))
				.map((missingServer) => (
					<div key={missingServer} className="text-xs text-vscode-errorForeground flex items-center gap-1">
						<span className="codicon codicon-warning" />
						{missingServer} (not connected)
					</div>
				))}
		</div>
	)
}

export default React.memo(McpServerChecklist)
