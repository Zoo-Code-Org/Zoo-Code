import React, { useState } from "react"
import type { ClineMessage } from "@roo-code/types"

import { AppProviders } from "../../../../playwright/AppProviders"
import ChatRow from "../ChatRow"

const messages: ClineMessage[] = [
	{ ts: 1, type: "say", say: "user_feedback", text: "Please update the greeting and explain the change." },
	{
		ts: 2,
		type: "say",
		say: "user_feedback_diff",
		text: JSON.stringify({ diff: "@@ -1 +1 @@\n-Hello world\n+Hello Zoo" }),
	},
	{
		ts: 3,
		type: "say",
		say: "text",
		text: "## Updated greeting\n\nThe greeting now welcomes **Zoo**.\n\n## Verification\n\nThe rest of the message is unchanged.",
	},
]

export function ChatRowConversationStory() {
	const [expanded, setExpanded] = useState(true)

	return (
		<AppProviders initialState={{ clineMessages: messages }}>
			<div data-testid="chat-row-conversation" className="w-[480px] max-w-full bg-vscode-editor-background">
				{messages.map((message) => (
					<div key={message.ts} data-testid={`chat-row-${message.say}`}>
						<ChatRow
							message={message}
							isExpanded={expanded}
							isLast={message.ts === 3}
							isStreaming={false}
							onToggleExpand={() => setExpanded((previous) => !previous)}
							onHeightChange={() => undefined}
						/>
					</div>
				))}
			</div>
		</AppProviders>
	)
}
