import type { ApiMessage } from "../task-persistence"

const staleSections = new Set([
	"VSCode Visible Files",
	"VSCode Open Tabs",
	"Current Time",
	"Current Cost",
	"Current Mode",
])

const environmentOpen = "<environment_details>"
const environmentClose = "</environment_details>"

function isEnvironmentBlock(text: string): boolean {
	const trimmed = text.trim()
	return trimmed.startsWith(environmentOpen) && trimmed.endsWith(environmentClose)
}

function retainUniqueObservations(text: string): string | undefined {
	const body = text.trim().slice(environmentOpen.length, -environmentClose.length).trim()
	// Reminders are current state, so only the latest copy is useful. Preserve
	// unfamiliar content rather than guessing whether it is safe to remove.
	const reminderStart = body.search(/^====\s*\n\s*REMINDERS\s*$/m)
	const withoutReminder = reminderStart < 0 ? body : body.slice(0, reminderStart).trim()
	const withoutEmptyTodo = withoutReminder.replace(
		/^You have not created a todo list yet\. Create one with `update_todo_list` if your task is complicated or involves multiple steps\.\s*$/m,
		"",
	)
	const sections = withoutEmptyTodo.split(/(?=^# )/m)
	const retained = sections
		.filter((section) => {
			const heading = /^# ([^\r\n]+)/.exec(section)?.[1]
			return !heading || !staleSections.has(heading)
		})
		.join("")
		.trim()
	return retained ? `${environmentOpen}\n${retained}\n${environmentClose}` : undefined
}

/** Remove superseded environment state from API requests without editing saved history. */
export function projectEnvironmentHistory(messages: ApiMessage[]): ApiMessage[] {
	let latestMessage = -1
	let latestBlock = -1
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const content = messages[messageIndex].content
		if (!Array.isArray(content)) continue
		for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
			const block = content[blockIndex]
			if (block.type === "text" && isEnvironmentBlock(block.text)) {
				latestMessage = messageIndex
				latestBlock = blockIndex
			}
		}
	}
	if (latestMessage < 0) return messages

	return messages.map((message, messageIndex) => {
		if (!Array.isArray(message.content) || messageIndex > latestMessage) return message
		let changed = false
		const content = message.content.flatMap((block, blockIndex) => {
			if (
				block.type !== "text" ||
				!isEnvironmentBlock(block.text) ||
				(messageIndex === latestMessage && blockIndex === latestBlock)
			) {
				return [block]
			}
			const retained = retainUniqueObservations(block.text)
			if (retained === block.text) return [block]
			changed = true
			return retained ? [{ ...block, text: retained }] : []
		})
		return changed ? { ...message, content } : message
	})
}
