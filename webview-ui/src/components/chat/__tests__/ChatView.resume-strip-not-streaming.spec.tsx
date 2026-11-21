// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/ChatView.resume-strip-not-streaming.spec.tsx

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

import React from "react"
import { renderWithExtensionState, makeExtensionState, waitFor } from "@/utils/test-utils"

import type { ClineMessage } from "@roo-code/types"

import ChatView, { ChatViewProps } from "../ChatView"

// #257: `Task.resumeTaskFromHistory()` trims a streaming tail before hydrating the
// resumed chat (src/core/task/Task.ts:3176-3240), and the webview derives its
// streaming lock from the message list alone (ChatView.tsx:566-608). The host spec
// (Task.persistence.spec.ts:2335-2441) pins the strip; this spec pins the other half
// of the contract: the shape the strip guarantees must not read as streaming, and
// the shape it removes must. The strip list is read from the host source instead of
// being copied here, so widening or narrowing it on the host side fails this spec.

// __tests__ -> chat -> components -> src -> webview-ui -> repo root
const HOST_TASK_SOURCE_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../../src/core/task/Task.ts",
)

/**
 * Extracts the `say` types the host resume cleanup pops from the source expression
 * `(lastMessage.say === "reasoning" || lastMessage.say === "text")`. Reading the
 * source keeps this spec coupled to the host strip list; a hand-copied list would
 * let the two sides drift silently, which is the coupling this spec exists to catch.
 */
const readHostStrippedPartialSayTypes = (): string[] => {
	const source = fs.readFileSync(HOST_TASK_SOURCE_PATH, "utf8")
	const start = source.indexOf("const isPartialStreamBubble =")

	if (start === -1) {
		throw new Error(`Could not find the resume strip expression in ${HOST_TASK_SOURCE_PATH}`)
	}

	const end = source.indexOf("lastMessage.partial === true", start)

	if (end === -1) {
		throw new Error(`Could not find the end of the resume strip expression in ${HOST_TASK_SOURCE_PATH}`)
	}

	return [...source.slice(start, end).matchAll(/lastMessage\.say === "([^"]+)"/g)].map((match) => match[1]!)
}

const HOST_STRIPPED_PARTIAL_SAY_TYPES = readHostStrippedPartialSayTypes()

/**
 * `say` types the streaming loop can emit with `partial: true` and a text body.
 * Producers: `presentAssistantMessage.ts:443` (text) and `Task.ts:4215` (reasoning).
 * Every one of them must be in the host strip list, otherwise an interrupted stream
 * leaves the bubble behind and the resumed chat re-locks on `partial === true`.
 *
 * This list is the contract the host strip is checked against, so it is written
 * explicitly here instead of being derived from the host source. Deriving both sides
 * from the same expression would let a narrowed host list pass unnoticed.
 */
const STREAMING_PARTIAL_SAY_TYPES = ["reasoning", "text"] as const

/**
 * Applies the resume-time cleanup from `Task.resumeTaskFromHistory()` so the
 * post-strip assertions are derived from the pre-strip history the host reads off
 * disk instead of being hand-written twice.
 *
 * `assistantTexts` mirrors the API-history turns the host reads before deciding
 * whether an interrupted text bubble can be restored: a partial `text` bubble whose
 * complete text is already in API history comes back as a finalized row, everything
 * else in the streaming tail is dropped.
 */
const applyHostResumeStrip = (messages: ClineMessage[], assistantTexts: string[] = []): ClineMessage[] => {
	const stripped = [...messages]
	const trailingPartialStreamBubbles: ClineMessage[] = []

	while (stripped.length > 0) {
		const lastMessage = stripped[stripped.length - 1]

		if (
			lastMessage?.type !== "say" ||
			!HOST_STRIPPED_PARTIAL_SAY_TYPES.includes(lastMessage.say ?? "") ||
			lastMessage.partial !== true
		) {
			break
		}

		trailingPartialStreamBubbles.unshift(stripped.pop()!)
	}

	const lastApiReqStartedIndex = stripped.findLastIndex(
		(message) => message.type === "say" && message.say === "api_req_started",
	)

	if (lastApiReqStartedIndex !== -1) {
		const lastApiReqStarted = stripped[lastApiReqStartedIndex]
		const { cost, cancelReason } = JSON.parse(lastApiReqStarted?.text || "{}")

		if (cost === undefined && cancelReason === undefined) {
			stripped.splice(lastApiReqStartedIndex, 1)
		}
	}

	for (const bubble of trailingPartialStreamBubbles) {
		if (bubble.say === "text" && assistantTexts.includes(bubble.text ?? "")) {
			stripped.push({ ...bubble, partial: false })
		}
	}

	return stripped
}

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("use-sound", () => ({
	default: vi.fn().mockImplementation(() => [vi.fn()]),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
	Trans: ({ i18nKey, children }: { i18nKey: string; children?: React.ReactNode }) => <>{children || i18nKey}</>,
}))

vi.mock("../ChatRow", () => ({
	default: function MockChatRow({ message }: { message: ClineMessage }) {
		return <div data-testid="chat-row">{JSON.stringify(message)}</div>
	},
}))

// The send button is the user-visible half of the lock: `isStreaming` swaps Send
// for Stop and routes input into the queue instead of sending.
vi.mock("../ChatTextArea", () => ({
	ChatTextArea: React.forwardRef(function MockChatTextArea(
		{ isStreaming }: { isStreaming?: boolean },
		_ref: React.ForwardedRef<HTMLTextAreaElement>,
	) {
		return <div data-testid="chat-textarea" data-is-streaming={String(isStreaming === true)} />
	}),
}))

vi.mock("../AutoApproveMenu", () => ({
	default: () => null,
}))

vi.mock("react-virtuoso", () => ({
	Virtuoso: function MockVirtuoso({
		data,
		itemContent,
	}: {
		data: ClineMessage[]
		itemContent: (index: number, item: ClineMessage) => React.ReactNode
	}) {
		return (
			<div data-testid="virtuoso-item-list">
				{data.map((item, index) => (
					<div key={item.ts}>{itemContent(index, item)}</div>
				))}
			</div>
		)
	},
}))

vi.mock("../../common/VersionIndicator", () => ({
	default: () => null,
}))

vi.mock("@src/components/welcome/RooTips", () => ({
	default: () => null,
}))

vi.mock("@src/components/welcome/RooHero", () => ({
	default: () => null,
}))

vi.mock("../common/TelemetryBanner", () => ({
	default: () => null,
}))

const defaultProps: ChatViewProps = {
	isHidden: false,
	showAnnouncement: false,
	hideAnnouncement: () => {},
}

const renderWithMessages = (clineMessages: ClineMessage[]) =>
	renderWithExtensionState(<ChatView {...defaultProps} />, {
		state: makeExtensionState({ clineMessages }),
	})

const expectStreaming = async (expected: boolean) => {
	await waitFor(() => {
		expect(document.querySelector('[data-testid="chat-textarea"]')).toHaveAttribute(
			"data-is-streaming",
			String(expected),
		)
	})
}

const taskMessage: ClineMessage = { type: "say", say: "text", ts: 1, text: "Original task" }
const settledApiReqStarted: ClineMessage = {
	type: "say",
	say: "api_req_started",
	ts: 3,
	text: JSON.stringify({ apiProtocol: "anthropic", cost: 0.002 }),
}
const danglingApiReqStarted: ClineMessage = {
	type: "say",
	say: "api_req_started",
	ts: 3,
	text: JSON.stringify({ apiProtocol: "anthropic" }),
}

describe("ChatView - resume strip leaves a non-streaming chat", () => {
	beforeEach(() => vi.clearAllMocks())

	it("keeps every streaming partial say type in the host strip list", () => {
		// A silent change to the parse target would otherwise leave the assertions
		// below running against an empty list and passing for the wrong reason.
		expect(HOST_STRIPPED_PARTIAL_SAY_TYPES.length).toBeGreaterThan(0)
		// Dropping a say type from the host strip list is exactly the decoupling this
		// spec exists to catch: the bubble survives resume and the chat re-locks.
		expect(HOST_STRIPPED_PARTIAL_SAY_TYPES).toEqual(expect.arrayContaining([...STREAMING_PARTIAL_SAY_TYPES]))
	})

	it.each(STREAMING_PARTIAL_SAY_TYPES)(
		"reads a trailing partial %s bubble as streaming before the host strips it",
		async (say) => {
			// This is the shape that reaches the webview when the host strip list loses a
			// say type: the resumed chat renders "API Request..." with a Stop button.
			renderWithMessages([taskMessage, { type: "say", say, ts: 2, text: "Half a sentence", partial: true }])

			await expectStreaming(true)
		},
	)

	it("reads a trailing dangling api_req_started as streaming before the host strips it", async () => {
		renderWithMessages([taskMessage, danglingApiReqStarted])

		await expectStreaming(true)
	})

	it.each(STREAMING_PARTIAL_SAY_TYPES)(
		"reads the post-strip shape left by stripping a partial %s tail as not streaming",
		async (say) => {
			const partialTail: ClineMessage = { type: "say", say, ts: 2, text: "Half a sentence", partial: true }
			const postStrip = applyHostResumeStrip([taskMessage, partialTail])

			// If the host strip list loses this say type, the partial tail survives and the
			// resumed chat stays locked, so this assertion is what catches the drift.
			expect(postStrip).toEqual([taskMessage])
			renderWithMessages(postStrip)

			await expectStreaming(false)
		},
	)

	it("reads the post-strip shape left by stripping a dangling api_req_started as not streaming", async () => {
		const postStrip = applyHostResumeStrip([taskMessage, settledApiReqStarted, danglingApiReqStarted])

		expect(postStrip).toEqual([taskMessage, settledApiReqStarted])
		renderWithMessages(postStrip)

		await expectStreaming(false)
	})

	it("does not stream on a kept partial command_output tail", async () => {
		// The host deliberately keeps partial command output (it records work that
		// already ran). `combineCommandSequences` folds it into the command ask, so it
		// never becomes the last message the streaming check looks at.
		renderWithMessages([
			taskMessage,
			{ type: "ask", ask: "command", ts: 2, text: "npm test", partial: false },
			{ type: "say", say: "command_output", ts: 3, text: "npm test\n", partial: true },
		])

		await expectStreaming(false)
	})

	it("reads the restored finalized text shape as not streaming", async () => {
		// The assistant turn is appended to API history before the presenter that
		// clears `partial` runs, so an abort between them leaves a partial text bubble
		// whose complete text is already persisted. The host restores it with
		// `partial: false`; retaining the text must not reinstate the streaming lock.
		const partialTail: ClineMessage = { type: "say", say: "text", ts: 2, text: "Half a sentence", partial: true }
		const postStrip = applyHostResumeStrip([taskMessage, partialTail], ["Half a sentence"])

		expect(postStrip).toEqual([taskMessage, { ...partialTail, partial: false }])
		renderWithMessages(postStrip)

		await expectStreaming(false)
	})

	it("still streams if a restored text row is left partial", async () => {
		// Guards the `partial: false` half of the restore: keeping the row without
		// clearing the flag would reintroduce exactly the #257 lock the strip removes.
		// The input is the restore's own output with the flag put back, so this case
		// stays pinned to the restore path instead of repeating the `text` arm above.
		const partialTail: ClineMessage = { type: "say", say: "text", ts: 2, text: "Half a sentence", partial: true }
		const restored = applyHostResumeStrip([taskMessage, partialTail], ["Half a sentence"])
		const leftPartial = restored.map((message) =>
			message.say === "text" ? { ...message, partial: true } : message,
		)

		renderWithMessages(leftPartial)

		await expectStreaming(true)
	})

	it("drops a partial text tail whose text is absent from API history", async () => {
		// No matching turn means the text exists nowhere else, so the bubble stays
		// orphaned and is removed rather than restored.
		const partialTail: ClineMessage = { type: "say", say: "text", ts: 2, text: "Half a sentence", partial: true }
		const postStrip = applyHostResumeStrip([taskMessage, partialTail], ["An older answer"])

		expect(postStrip).toEqual([taskMessage])
		renderWithMessages(postStrip)

		await expectStreaming(false)
	})
})
