import React from "react"
import { AppProviders } from "../../../../playwright/AppProviders"
import MarkdownBlock from "../../common/MarkdownBlock"
import { ReasoningBlock } from "../ReasoningBlock"

const table = `| File | Status |
| --- | --- |
| Composer | Updated |
| Reasoning | Streaming |
| Markdown | Striped |
| Settings | Saved |`

export function ChatEffectsStory() {
	return (
		<AppProviders initialState={{ reasoningBlockCollapsed: false, tableStriped: true }}>
			<div
				data-testid="chat-effects-story"
				className="w-[488px] max-w-full bg-vscode-editor-background text-vscode-foreground p-4 space-y-4">
				<ReasoningBlock content="Checking the chat visuals." ts={0} isStreaming isLast />
				<MarkdownBlock markdown={table} striped />
			</div>
		</AppProviders>
	)
}
