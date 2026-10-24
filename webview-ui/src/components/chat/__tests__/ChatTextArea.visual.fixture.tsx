import React, { useState } from "react"

import { defaultModeSlug, type Mode } from "@roo/modes"
import type { ClineMessage } from "@roo-code/types"
import { AppProviders } from "../../../../playwright/AppProviders"
import { ChatTextArea } from "../ChatTextArea"

export function ChatTextAreaStory() {
	const [inputValue, setInputValue] = useState("Audit contrast across the Zoo Code webview")
	const [selectedImages, setSelectedImages] = useState<string[]>([])
	const [mode, setMode] = useState<Mode>(defaultModeSlug)

	return (
		<AppProviders>
			<div
				data-testid="chat-text-area-story"
				className="w-[488px] max-w-full rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-3">
				<ChatTextArea
					inputValue={inputValue}
					setInputValue={setInputValue}
					sendingDisabled={false}
					selectApiConfigDisabled={false}
					placeholderText="Type a message"
					selectedImages={selectedImages}
					setSelectedImages={setSelectedImages}
					onSend={() => undefined}
					onSelectImages={() => undefined}
					shouldDisableImages={false}
					mode={mode}
					setMode={setMode}
					modeShortcutText="Ctrl+. for next mode"
				/>
			</div>
		</AppProviders>
	)
}

// Prompt history is derived from the current task's user messages, so the
// picker needs a non-empty conversation. The extra top padding keeps the
// popover, which opens upward from the composer, inside the screenshot bounds.
const historyMessages: ClineMessage[] = [
	{ ts: 1, type: "say", say: "user_feedback", text: "Add a retry guard to the upload test" },
	{ ts: 2, type: "say", say: "user_feedback", text: "Explain the diff for the parser change" },
]

export function ChatTextAreaHistoryStory() {
	const [inputValue, setInputValue] = useState("")
	const [selectedImages, setSelectedImages] = useState<string[]>([])
	const [mode, setMode] = useState<Mode>(defaultModeSlug)

	return (
		<AppProviders initialState={{ clineMessages: historyMessages }}>
			<div
				data-testid="chat-text-area-story"
				className="w-[488px] max-w-full rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-3 pt-[140px]">
				<ChatTextArea
					inputValue={inputValue}
					setInputValue={setInputValue}
					sendingDisabled={false}
					selectApiConfigDisabled={false}
					placeholderText="Type a message"
					selectedImages={selectedImages}
					setSelectedImages={setSelectedImages}
					onSend={() => undefined}
					onSelectImages={() => undefined}
					shouldDisableImages={false}
					mode={mode}
					setMode={setMode}
					modeShortcutText="Ctrl+. for next mode"
				/>
			</div>
		</AppProviders>
	)
}
