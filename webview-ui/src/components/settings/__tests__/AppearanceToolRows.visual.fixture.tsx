import { useState } from "react"

import { applyAppearanceVariables } from "@src/utils/appearance"
import { AppProviders } from "../../../../playwright/AppProviders"
import ChatRow from "../../chat/ChatRow"

const toolInfo = {
	command: "init",
	skill: "deploy-helper",
	args: "--force",
	description: "Starts a new project",
	source: "project",
}

const toolMessage = (type: "ask" | "say", ts: number, tool: "skill" | "runSlashCommand") =>
	type === "ask"
		? { type, ask: "tool" as const, ts, text: JSON.stringify({ tool, ...toolInfo }) }
		: { type, say: "tool" as const, ts, text: JSON.stringify({ tool, ...toolInfo }) }

const rows = [
	{ testId: "tool-skill", message: toolMessage("ask", 1, "skill") },
	{ testId: "tool-slash-ask", message: toolMessage("ask", 2, "runSlashCommand") },
	{ testId: "tool-slash-say", message: toolMessage("say", 3, "runSlashCommand") },
]

/**
 * The tool rows of the chat whose names, arguments, descriptions and source badges are sized from the interface scale,
 * with two buttons that apply the scale to <html> (through the same function the app uses) or remove it again.
 */
export function AppearanceToolRowsStory() {
	const [applied, setApplied] = useState(false)

	return (
		<AppProviders>
			<div
				data-testid="appearance-tool-rows-story"
				className="flex w-[480px] max-w-full flex-col gap-4 rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
				<div className="flex gap-2">
					<button
						type="button"
						data-testid="apply-scale"
						onClick={() => {
							applyAppearanceVariables(document.documentElement, { interfaceFontScale: 150 })
							setApplied(true)
						}}>
						Apply
					</button>
					<button
						type="button"
						data-testid="remove-scale"
						onClick={() => {
							applyAppearanceVariables(document.documentElement, {})
							setApplied(false)
						}}>
						Remove
					</button>
					<span data-testid="scale-state">{applied ? "set" : "unset"}</span>
				</div>

				{rows.map(({ testId, message }) => (
					<div key={testId} data-testid={testId}>
						<ChatRow
							message={message}
							isExpanded={false}
							isLast={false}
							isStreaming={false}
							onToggleExpand={() => {}}
							onHeightChange={() => {}}
							isFollowUpAnswered={false}
						/>
					</div>
				))}
			</div>
		</AppProviders>
	)
}
