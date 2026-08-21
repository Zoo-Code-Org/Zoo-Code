import { MessageQueueService } from "../MessageQueueService"

describe("MessageQueueService claims", () => {
	it("keeps claimed messages unavailable while later messages remain consumable", () => {
		const queue = new MessageQueueService()
		const first = queue.addMessage("first")!
		const second = queue.addMessage("second")!

		expect(queue.claimMessage(first.id)).toBe(true)
		expect(queue.peekMessage()).toEqual(second)
		expect(queue.dequeueMessage()).toEqual(second)
		expect(queue.peekMessage()).toBeUndefined()
		expect(queue.dequeueMessage()).toBeUndefined()
		expect(queue.messages).toEqual([first])
	})

	it("rejects duplicate and unknown claims", () => {
		const queue = new MessageQueueService()
		const message = queue.addMessage("feedback")!

		expect(queue.claimMessage(message.id)).toBe(true)
		expect(queue.claimMessage(message.id)).toBe(false)
		expect(queue.claimMessage("missing")).toBe(false)
	})

	it("clears claim state when a message is removed or the queue is disposed", () => {
		const queue = new MessageQueueService()
		const message = queue.addMessage("feedback")!
		queue.claimMessage(message.id)

		expect(queue.removeMessage(message.id)).toBe(true)
		expect(queue.removeMessage(message.id)).toBe(false)
		expect(queue.claimMessage(message.id)).toBe(false)

		const next = queue.addMessage("next")!
		queue.claimMessage(next.id)
		queue.dispose()
		expect(queue.messages).toEqual([])
		expect(queue.claimMessage(next.id)).toBe(false)
	})
})
