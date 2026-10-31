import { useState } from "react"

import { applyAppearanceVariables, type AppearanceValues } from "@src/utils/appearance"
import { AppProviders } from "../../../../playwright/AppProviders"
import ChatRow from "../../chat/ChatRow"
import { QueuedMessages } from "../../chat/QueuedMessages"
import { TerminalOutput } from "../../chat/TerminalOutput"
import CodeBlock from "../../common/CodeBlock"
import DiffView from "../../common/DiffView"
import MarkdownBlock from "../../common/MarkdownBlock"

const VALUES: AppearanceValues = {
	interfaceFontScale: 150,
	terminalFontSize: 20,
	editorFontSize: 22,
	spacingScale: 150,
}

const diff = `@@ -1,3 +1,3 @@
 export function greet(name: string) {
-  return "Hello " + name
+  return \`Hello \${name}\`
 }`

/**
 * The parts of the UI that read the appearance variables, with two buttons that apply the saved values to <html>
 * (through the same function the app uses) or remove them again.
 */
export function AppearanceConsumersStory() {
	const [applied, setApplied] = useState(false)
	const apply = (values: AppearanceValues) => applyAppearanceVariables(document.documentElement, values)

	return (
		<AppProviders>
			<div
				data-testid="appearance-consumers-story"
				className="flex w-[480px] max-w-full flex-col gap-4 rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
				<div className="flex gap-2">
					<button
						type="button"
						data-testid="apply-appearance"
						onClick={() => {
							apply(VALUES)
							setApplied(true)
						}}>
						Apply
					</button>
					<button
						type="button"
						data-testid="remove-appearance"
						onClick={() => {
							apply({})
							setApplied(false)
						}}>
						Remove
					</button>
					<span data-testid="appearance-state">{applied ? "set" : "unset"}</span>
				</div>

				<div data-testid="consumer-markdown">
					<MarkdownBlock markdown={"A paragraph of chat text, with `inline code` in it."} />
				</div>
				<div data-testid="consumer-chat-row">
					<ChatRow
						message={{ type: "say", say: "text", ts: 1, text: "A chat row with an assistant reply." }}
						isExpanded={false}
						isLast={false}
						isStreaming={false}
						onToggleExpand={() => {}}
						onHeightChange={() => {}}
						isFollowUpAnswered={false}
					/>
				</div>
				<div data-testid="consumer-queued">
					<QueuedMessages
						queue={[{ id: "q1", timestamp: 1, text: "A queued message" }]}
						onRemove={() => {}}
						onUpdate={() => {}}
					/>
				</div>
				<div data-testid="consumer-code">
					<CodeBlock source={"const greeting = `Hello, Zoo Code`"} language="typescript" />
				</div>
				<div data-testid="consumer-diff">
					<DiffView source={diff} />
				</div>
				<div data-testid="consumer-terminal">
					<TerminalOutput content={"Tests passed\n24 passing"} />
				</div>
			</div>
		</AppProviders>
	)
}
