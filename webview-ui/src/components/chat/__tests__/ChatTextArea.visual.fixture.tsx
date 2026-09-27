import React, { useState } from "react"

import { defaultModeSlug, type Mode } from "@roo/modes"
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
