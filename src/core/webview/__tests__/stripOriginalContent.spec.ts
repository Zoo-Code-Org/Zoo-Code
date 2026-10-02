import type { ClineMessage, ExtensionMessage } from "@roo-code/types"

import {
	findOriginalContent,
	omitOriginalContent,
	omitOriginalContentFromExtensionMessage,
} from "../stripOriginalContent"

let ts = 0
const toolAsk = (payload: unknown, extra: Partial<ClineMessage> = {}): ClineMessage => ({
	ts: ++ts,
	type: "ask",
	ask: "tool",
	text: typeof payload === "string" ? payload : JSON.stringify(payload),
	...extra,
})

const bigOriginal = "line of the original file\n".repeat(2000)

describe("omitOriginalContent", () => {
	it("removes a non-empty originalContent and records its length", () => {
		const message = toolAsk({
			tool: "appliedDiff",
			path: "a.ts",
			diff: "@@ d",
			content: "patch",
			originalContent: bigOriginal,
		})

		const result = omitOriginalContent(message)
		const payload = JSON.parse(result.text!)

		expect(payload).toEqual({
			tool: "appliedDiff",
			path: "a.ts",
			diff: "@@ d",
			content: "patch",
			originalContentLength: bigOriginal.length,
		})
		expect(result.text!.length).toBeLessThan(message.text!.length / 10)
		expect(result).not.toBe(message)
		expect(result.ts).toBe(message.ts)
	})

	it("does not modify the original message object", () => {
		const message = toolAsk({ tool: "appliedDiff", path: "a.ts", originalContent: bigOriginal })
		const before = message.text

		omitOriginalContent(message)

		expect(message.text).toBe(before)
	})

	it("keeps an empty originalContent (a new file) inline", () => {
		const message = toolAsk({ tool: "newFileCreated", path: "new.ts", content: "x", originalContent: "" })

		expect(omitOriginalContent(message)).toBe(message)
	})

	it("works for say tool messages", () => {
		const message: ClineMessage = {
			ts: ++ts,
			type: "say",
			say: "tool",
			text: JSON.stringify({ tool: "editedExistingFile", path: "a.ts", originalContent: bigOriginal }),
		}

		expect(JSON.parse(omitOriginalContent(message).text!).originalContentLength).toBe(bigOriginal.length)
	})

	it("leaves messages without originalContent untouched", () => {
		const messages = [
			toolAsk({ tool: "readFile", path: "a.ts" }),
			toolAsk({ tool: "appliedDiff", path: "a.ts", diff: "d" }),
			{ ts: ++ts, type: "say", say: "text", text: "originalContent is only a word here" } as ClineMessage,
			{ ts: ++ts, type: "ask", ask: "command", text: '{"originalContent":"not a tool message"}' } as ClineMessage,
			{ ts: ++ts, type: "ask", ask: "tool" } as ClineMessage,
		]

		for (const message of messages) {
			expect(omitOriginalContent(message)).toBe(message)
		}
	})

	it("leaves unparsable text untouched", () => {
		const message = toolAsk('{"tool":"appliedDiff","originalContent":"cut off')

		expect(omitOriginalContent(message)).toBe(message)
	})

	it("leaves a non-string originalContent untouched", () => {
		const message = toolAsk({ tool: "appliedDiff", originalContent: 42 })

		expect(omitOriginalContent(message)).toBe(message)
	})

	it("reuses the result while the text is unchanged and recomputes after an in-place update", () => {
		const parse = vi.spyOn(JSON, "parse")
		const message = toolAsk({ tool: "appliedDiff", path: "a.ts", originalContent: bigOriginal })

		const first = omitOriginalContent(message)
		const second = omitOriginalContent(message)

		expect(second).toEqual(first)
		expect(parse).toHaveBeenCalledTimes(1)
		parse.mockRestore()

		// partial messages are updated in place by the task, so a new text must not return a stale result
		message.text = JSON.stringify({ tool: "appliedDiff", path: "b.ts", originalContent: bigOriginal + "more" })
		const third = omitOriginalContent(message)

		expect(JSON.parse(third.text!)).toMatchObject({ path: "b.ts", originalContentLength: bigOriginal.length + 4 })
	})

	it("takes metadata from the current message when the cached text is reused", () => {
		const message = toolAsk(
			{ tool: "appliedDiff", path: "a.ts", originalContent: bigOriginal },
			{ partial: false, isAnswered: false },
		)

		expect(omitOriginalContent(message).isAnswered).toBe(false)

		// approval only flips metadata; the text is unchanged
		message.isAnswered = true
		message.partial = true
		const result = omitOriginalContent(message)

		expect(result).toMatchObject({ isAnswered: true, partial: true })
		expect(JSON.parse(result.text!)).toMatchObject({ originalContentLength: bigOriginal.length })
		expect(result.text).not.toContain(bigOriginal.slice(0, 50))
	})

	it("is idempotent", () => {
		const once = omitOriginalContent(toolAsk({ tool: "appliedDiff", path: "a.ts", originalContent: bigOriginal }))

		expect(omitOriginalContent(once)).toBe(once)
	})
})

describe("findOriginalContent", () => {
	it("returns the originalContent of the tool message with that ts", () => {
		const messages = [
			toolAsk({ tool: "appliedDiff", path: "a.ts", originalContent: bigOriginal }),
			toolAsk({ tool: "appliedDiff", path: "b.ts", originalContent: "other" }),
		]

		expect(findOriginalContent(messages, { ts: messages[0]!.ts })).toBe(bigOriginal)
		expect(findOriginalContent(messages, { ts: messages[1]!.ts })).toBe("other")
	})

	it("tells messages created in the same millisecond apart by messageId", () => {
		const first = toolAsk({ tool: "appliedDiff", path: "a.ts", originalContent: "first" }, { messageId: "id-1" })
		const second = toolAsk(
			{ tool: "appliedDiff", path: "b.ts", originalContent: "second" },
			{ messageId: "id-2", ts: first.ts },
		)
		const messages = [first, second]

		expect(findOriginalContent(messages, { messageId: "id-2", ts: first.ts })).toBe("second")
		expect(findOriginalContent(messages, { messageId: "id-1", ts: first.ts })).toBe("first")
		expect(findOriginalContent(messages, { messageId: "missing", ts: first.ts })).toBeNull()
		// messages persisted without an id are still found by ts
		expect(findOriginalContent(messages, { ts: first.ts })).toBe("first")
	})

	it("finds say tool messages too", () => {
		const message: ClineMessage = {
			ts: ++ts,
			type: "say",
			say: "tool",
			text: JSON.stringify({ tool: "editedExistingFile", originalContent: bigOriginal }),
		}

		expect(findOriginalContent([message], { ts: message.ts })).toBe(bigOriginal)
	})

	it("returns null when there is nothing to return", () => {
		const noOriginal = toolAsk({ tool: "readFile", path: "a.ts" })
		const notTool: ClineMessage = {
			ts: ++ts,
			type: "say",
			say: "text",
			text: JSON.stringify({ originalContent: "x" }),
		}
		const unparsable = toolAsk('{"originalContent":"cut off')
		const notAString = toolAsk({ tool: "appliedDiff", originalContent: 42 })
		const noText: ClineMessage = { ts: ++ts, type: "ask", ask: "tool" }
		const all = [noOriginal, notTool, unparsable, notAString, noText]

		for (const message of all) {
			expect(findOriginalContent(all, { ts: message.ts })).toBeNull()
		}

		expect(findOriginalContent(all, { ts: -1 })).toBeNull()
		expect(findOriginalContent(undefined, { ts: 1 })).toBeNull()
	})

	it("returns an empty original as an empty string", () => {
		const message = toolAsk({ tool: "newFileCreated", content: "x", originalContent: "" })

		expect(findOriginalContent([message], { ts: message.ts })).toBe("")
	})
})

describe("omitOriginalContentFromExtensionMessage", () => {
	it("applies to the chat messages inside a state message without touching other state", () => {
		const message = {
			type: "state",
			state: {
				version: "1",
				mode: "code",
				clineMessages: [toolAsk({ tool: "appliedDiff", path: "a.ts", originalContent: bigOriginal })],
			},
		} as unknown as ExtensionMessage

		const result = omitOriginalContentFromExtensionMessage(message)

		expect(result.state).toMatchObject({ version: "1", mode: "code" })
		expect(JSON.parse(result.state!.clineMessages![0]!.text!).originalContentLength).toBe(bigOriginal.length)
	})

	it("applies to messageUpdated", () => {
		const message = {
			type: "messageUpdated",
			clineMessage: toolAsk({ tool: "appliedDiff", path: "a.ts", originalContent: bigOriginal }),
		} as ExtensionMessage

		const result = omitOriginalContentFromExtensionMessage(message)

		expect(JSON.parse(result.clineMessage!.text!).originalContentLength).toBe(bigOriginal.length)
	})

	it("passes every other message through unchanged", () => {
		const others = [
			{ type: "action", action: "didBecomeVisible" },
			{ type: "state", state: { clineMessages: [] } },
			{ type: "state" },
			{ type: "fileContent", fileContent: { path: "a", content: bigOriginal } },
		] as unknown as ExtensionMessage[]

		for (const message of others) {
			expect(omitOriginalContentFromExtensionMessage(message)).toBe(message)
		}
	})
})
