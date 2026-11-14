import { render, screen } from "@/utils/test-utils"
import type { QueuedMessage } from "@roo-code/types"

import { QueuedMessages } from "../QueuedMessages"

vi.mock("../common/Thumbnails", () => ({ default: () => null }))
vi.mock("./Mention", () => ({ Mention: () => null }))

const { tSpy } = vi.hoisted(() => ({ tSpy: vi.fn((key: string) => key) }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => tSpy(key) }),
}))

describe("QueuedMessages - the heading it puts over the queue", () => {
	it("titles the queue and renders each queued message's text", () => {
		const queue: QueuedMessage[] = [{ id: "queued-1", text: "keep the diff open" } as QueuedMessage]

		render(<QueuedMessages queue={queue} onRemove={vi.fn()} onUpdate={vi.fn()} />)

		expect(tSpy).toHaveBeenCalledWith("chat:queuedMessages.title")
		expect(screen.getByTestId("queued-messages")).toHaveTextContent("chat:queuedMessages.title")
		// The heading alone does not prove the queue hands each message's own text to
		// the render, so assert the queued text itself, not only the title above it.
		expect(screen.getByTestId("queued-messages")).toHaveTextContent("keep the diff open")
	})
})
