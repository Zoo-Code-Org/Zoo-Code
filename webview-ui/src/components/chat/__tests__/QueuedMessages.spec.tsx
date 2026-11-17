// npx vitest run src/components/chat/__tests__/QueuedMessages.spec.tsx

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { MentionSegment, QueuedMessage } from "@roo-code/types"

import { QueuedMessages } from "../QueuedMessages"

vi.mock("@src/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("../Mention", () => ({ Mention: ({ text }: { text: string }) => <span>{text}</span> }))
vi.mock("../../common/Thumbnails", () => ({ default: () => null }))

const user = (text: string): MentionSegment => ({ text, source: "user" })
const gen = (text: string): MentionSegment => ({ text, source: "generated" })

// Mirrors docs/architecture/tla/MentionOrigin.tla, QueueSave: the editor tags each input event.
describe("QueuedMessages editing", () => {
	const edit = (message: QueuedMessage, steps: Array<string | { value: string; inputType: string }>) => {
		const onUpdate = vi.fn()
		render(<QueuedMessages queue={[message]} onRemove={vi.fn()} onUpdate={onUpdate} />)
		fireEvent.click(screen.getByTitle("chat:queuedMessages.clickToEdit"))
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
		for (const step of steps) {
			const { value, inputType } = typeof step === "string" ? { value: step, inputType: "" } : step
			if (inputType) {
				// Set the value like the browser does, then send the typed input event.
				const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
				setter.call(textarea, value)
				textarea.dispatchEvent(new InputEvent("input", { inputType, bubbles: true }))
			} else {
				fireEvent.change(textarea, { target: { value } })
			}
		}
		fireEvent.blur(textarea)
		return onUpdate
	}

	const queued = (text: string, segments?: MentionSegment[]): QueuedMessage => ({
		id: "q1",
		timestamp: 1,
		text,
		segments,
	})

	it.each([
		{
			label: "two edits that trim both ends of generated text",
			message: queued("X @/etc/passwd Y", [gen("X @/etc/passwd Y")]),
			steps: ["X @/etc/passwd ", " @/etc/passwd ", "@/etc/passwd "],
			text: "@/etc/passwd ",
			segments: [gen("@/etc/passwd ")],
		},
		{
			label: "two insertions around one generated letter",
			message: queued("a", [gen("a")]),
			steps: ["aa", "aaa"],
			text: "aaa",
			segments: [gen("aaa")],
		},
		{
			label: "an appended typed word",
			message: queued("ctx @/x", [gen("ctx @/x")]),
			steps: ["ctx @/x m", "ctx @/x mine"],
			text: "ctx @/x mine",
			segments: [gen("ctx @/x"), user(" mine")],
		},
		{
			label: "a message with no segments",
			message: queued("old @/x"),
			steps: ["old @/x!"],
			text: "old @/x!",
			segments: [gen("old @/x"), user("!")],
		},
		{
			label: "an undo",
			message: queued("ctx", [user("ctx")]),
			steps: ["ctx m", { value: "ctx", inputType: "historyUndo" }],
			text: "ctx",
			segments: [gen("ctx")],
		},
	])("sends the right segments after $label", ({ message, steps, text, segments }) => {
		const onUpdate = edit(message, steps)
		expect(onUpdate).toHaveBeenCalledWith(0, text, segments)
	})
})
