import type { ClineMessage, HistoryItem } from "@roo-code/types"

import { AppProviders } from "../../../../playwright/AppProviders"
import TaskItemFooter from "@/components/history/TaskItemFooter"
import { ChatRowContent } from "../ChatRow"
import TaskHeader from "../TaskHeader"

/** The clock of the story: the visual test freezes it here, so "Today" and "Yesterday" labels stay stable. */
const TIMESTAMP_STORY_NOW = new Date("2026-06-01T12:00:00Z").getTime()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const formats = { timeFormat: "24h", dateFormat: "ymd" } as const

const row = (message: ClineMessage) => (
	<ChatRowContent
		key={`${message.say}-${message.ts}`}
		message={message}
		isExpanded={false}
		isLast={false}
		isStreaming={false}
		onToggleExpand={() => undefined}
		onSuggestionClick={() => undefined}
		onBatchFileResponse={() => undefined}
		onFollowUpUnmount={() => undefined}
		isFollowUpAnswered={false}
	/>
)

/** A user message, an assistant reply and a completion result, each with the time it was sent. */
export function ChatRowTimestampsStory() {
	return (
		<AppProviders initialState={formats}>
			<div
				data-testid="chat-row-timestamps-story"
				className="w-[480px] max-w-full bg-vscode-editor-background px-[15px] py-[10px] text-vscode-foreground">
				{row({
					type: "say",
					say: "user_feedback",
					ts: TIMESTAMP_STORY_NOW - 2 * HOUR,
					text: "Fix the login bug",
				})}
				{row({
					type: "say",
					say: "text",
					ts: TIMESTAMP_STORY_NOW - DAY,
					text: "I found the cause in the session store.",
				})}
				{row({
					type: "say",
					say: "completion_result",
					ts: TIMESTAMP_STORY_NOW - 9 * DAY,
					text: "The login bug is fixed.",
				})}
			</div>
		</AppProviders>
	)
}

/** The task header, with the time the task started. The test expands it. */
export function TaskHeaderTimestampStory() {
	const task: ClineMessage = {
		type: "say",
		say: "text",
		ts: TIMESTAMP_STORY_NOW - 3 * DAY,
		text: "Fix the login bug in the session store",
	}
	return (
		<AppProviders
			initialState={{
				...formats,
				currentTaskItem: {
					id: "task-1",
					number: 1,
					ts: task.ts,
					task: task.text ?? "",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}}>
			<div
				data-testid="task-header-timestamp-story"
				className="w-[480px] max-w-full bg-vscode-editor-background p-2 text-vscode-foreground">
				<TaskHeader
					task={task}
					tokensIn={1200}
					tokensOut={800}
					totalCost={0.12}
					contextTokens={2000}
					buttonsDisabled={false}
					handleCondenseContext={() => undefined}
				/>
			</div>
		</AppProviders>
	)
}

/** The footer of a history item with relative times turned off: the absolute date and time shows. */
export function TaskItemFooterAbsoluteStory() {
	const item: HistoryItem = {
		id: "task-1",
		number: 1,
		ts: TIMESTAMP_STORY_NOW - 26 * HOUR,
		task: "Write unit tests for the billing service",
		tokensIn: 1200,
		tokensOut: 800,
		totalCost: 0.12,
	}
	return (
		<AppProviders initialState={{ ...formats, showRelativeTimes: false }}>
			<div
				data-testid="task-item-footer-story"
				className="w-[480px] max-w-full bg-vscode-editor-background p-3 text-vscode-foreground">
				<TaskItemFooter item={item} variant="full" />
			</div>
		</AppProviders>
	)
}
