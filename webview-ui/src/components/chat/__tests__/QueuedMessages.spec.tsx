import { fireEvent, render, screen } from "@src/utils/test-utils"

import { QueuedMessages } from "../QueuedMessages"

describe("QueuedMessages", () => {
	const queue = [
		{
			id: "queue-1",
			text: "queued follow-up",
			images: [],
			timestamp: 1,
			createdAt: 1,
			updatedAt: 1,
			deliveryMode: "queue" as const,
		},
		{
			id: "steer-1",
			text: "steer next",
			images: [],
			timestamp: 2,
			createdAt: 2,
			updatedAt: 2,
			deliveryMode: "steer" as const,
		},
	]

	it("separates queue and steer lanes and can move messages between them", () => {
		const onUpdate = vi.fn()

		render(<QueuedMessages queue={queue} onRemove={vi.fn()} onUpdate={onUpdate} />)

		expect(screen.getByText("queued follow-up")).toBeInTheDocument()
		expect(screen.getByText("steer next")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "Steer" }))
		expect(onUpdate).toHaveBeenCalledWith(queue[0], { deliveryMode: "steer" })

		fireEvent.click(screen.getByRole("button", { name: "Queue" }))
		expect(onUpdate).toHaveBeenCalledWith(queue[1], { deliveryMode: "queue" })
	})

	it("saves edited queued message text", () => {
		const onUpdate = vi.fn()

		render(<QueuedMessages queue={[queue[0]]} onRemove={vi.fn()} onUpdate={onUpdate} />)

		fireEvent.click(screen.getByText("queued follow-up"))

		const editor = screen.getByRole("textbox")
		fireEvent.change(editor, { target: { value: "updated follow-up" } })
		fireEvent.keyDown(editor, { key: "Enter", code: "Enter" })

		expect(onUpdate).toHaveBeenCalledWith(queue[0], { text: "updated follow-up" })
	})
})
