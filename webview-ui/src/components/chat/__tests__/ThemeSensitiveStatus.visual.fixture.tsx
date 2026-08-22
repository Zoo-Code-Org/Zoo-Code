import React from "react"

import McpToolRow from "../../mcp/McpToolRow"
import { CommandPatternSelector } from "../CommandPatternSelector"

export function ThemeSensitiveStatusFixture() {
	return (
		<main
			data-testid="status-surface"
			className="w-[480px] space-y-5 rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
			<section aria-labelledby="commands-title" className="space-y-2">
				<h2 id="commands-title" className="m-0 text-base font-semibold">
					Command permissions
				</h2>
				<CommandPatternSelector
					patterns={[
						{ pattern: "pnpm test", description: "Run the test suite" },
						{ pattern: "rm -rf", description: "Remove files recursively" },
					]}
					allowedCommands={["pnpm test"]}
					deniedCommands={["rm -rf"]}
					onAllowPatternChange={() => undefined}
					onDenyPatternChange={() => undefined}
				/>
			</section>

			<section aria-labelledby="mcp-title" className="space-y-2">
				<h2 id="mcp-title" className="m-0 text-base font-semibold">
					MCP tools
				</h2>
				<McpToolRow
					tool={{
						name: "search_workspace",
						description: "Search files and symbols in the current workspace",
						enabledForPrompt: false,
						inputSchema: { type: "object", properties: {} },
					}}
					serverName="workspace-tools"
				/>
			</section>
		</main>
	)
}
