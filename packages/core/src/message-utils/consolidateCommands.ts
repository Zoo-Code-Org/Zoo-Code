import type { ClineMessage } from "@roo-code/types"

import { safeJsonParse } from "./safeJsonParse.js"

export const COMMAND_OUTPUT_STRING = "Output:"

type TextSnapshot = { parts: string[]; text: string }
// Values contain strings, never their owning message/transcript. Task switches
// can collect the keys and their derived output together.
const commandTextCache = new WeakMap<ClineMessage, TextSnapshot>()
const mcpTextCache = new WeakMap<ClineMessage, TextSnapshot>()

function reuseText(
	cache: WeakMap<ClineMessage, TextSnapshot>,
	message: ClineMessage,
	parts: string[],
	build: () => string,
): string {
	const previous = cache.get(message)
	if (
		previous &&
		previous.parts.length === parts.length &&
		parts.every((part, index) => part === previous.parts[index])
	)
		return previous.text
	const text = build()
	cache.set(message, { parts, text })
	return text
}

/**
 * Consolidates sequences of command and command_output messages in an array of ClineMessages.
 * Also consolidates sequences of use_mcp_server and mcp_server_response messages.
 *
 * This function processes an array of ClineMessages objects, looking for sequences
 * where a 'command' message is followed by one or more 'command_output' messages,
 * or where a 'use_mcp_server' message is followed by one or more 'mcp_server_response' messages.
 * When such a sequence is found, it consolidates them into a single message, merging
 * their text contents.
 *
 * @param messages - An array of ClineMessage objects to process.
 * @returns A new array of ClineMessage objects with command and MCP sequences consolidated.
 *
 * @example
 * const messages: ClineMessage[] = [
 *   { type: 'ask', ask: 'command', text: 'ls', ts: 1625097600000 },
 *   { type: 'ask', ask: 'command_output', text: 'file1.txt', ts: 1625097601000 },
 *   { type: 'ask', ask: 'command_output', text: 'file2.txt', ts: 1625097602000 }
 * ];
 * const result = consolidateCommands(messages);
 * // Result: [{ type: 'ask', ask: 'command', text: 'ls\nfile1.txt\nfile2.txt', ts: 1625097600000 }]
 */
export function consolidateCommands(messages: ClineMessage[]): ClineMessage[] {
	const result: ClineMessage[] = []
	let command:
		| { index: number; chunks: string[]; previous?: { type: "ask" | "say"; text: string }; hasText: boolean }
		| undefined
	let mcp: { index: number; responses: string[] } | undefined
	const finishCommand = () => {
		if (command) {
			const message = result[command.index]
			if (message) {
				const chunks = command.chunks
				const text = reuseText(commandTextCache, message, chunks, () => {
					// Keep untouched output strings shared/lazy until a visible row needs them.
					let combined = ""
					for (const chunk of chunks) combined += chunk
					return combined
				})
				result[command.index] = { ...message, text }
			}
		}
	}
	const finishMcp = () => {
		if (!mcp) return
		const message = result[mcp.index]
		if (!message) return
		if (mcp.responses.length === 0) {
			result[mcp.index] = { ...message }
			return
		}
		const responses = mcp.responses
		const text = reuseText(mcpTextCache, message, [message.text ?? "", ...responses], () => {
			const parsed = safeJsonParse<unknown>(message.text || "{}", {})
			const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
			return JSON.stringify({ ...data, response: responses.join("\n") })
		})
		result[mcp.index] = { ...message, text }
	}
	for (const message of messages) {
		if (!message) continue
		if (message.type === "ask" && message.ask === "command") {
			finishCommand()
			command = { index: result.length, chunks: [message.text || ""], hasText: false }
			result.push(message)
		} else if (message.type === "ask" && message.ask === "use_mcp_server") {
			finishMcp()
			mcp = { index: result.length, responses: [] }
			result.push(message)
		} else if (message.ask === "command_output" || message.say === "command_output") {
			if (!command) continue // Preserve legacy orphan-output filtering.
			const text = message.text || ""
			if (!command.previous) command.chunks.push("\n" + COMMAND_OUTPUT_STRING)
			const duplicate =
				command.previous && command.previous.type !== message.type && command.previous.text === text
			if (text && !duplicate) {
				if (command.hasText) command.chunks.push("\n")
				command.chunks.push(text)
				command.hasText = true
			}
			command.previous = { type: message.type, text }
		} else if (message.say === "mcp_server_response") {
			mcp?.responses.push(message.text || "")
		} else result.push(message)
	}
	finishCommand()
	finishMcp()
	return result
}
