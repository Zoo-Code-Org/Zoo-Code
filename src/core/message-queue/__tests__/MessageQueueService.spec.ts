import { MessageQueueService } from "../MessageQueueService"

describe("MessageQueueService claims", () => {
	it("keeps claimed messages unavailable while later messages remain consumable", () => {
		const queue = new MessageQueueService()
		const first = queue.addMessage("first")!
		const second = queue.addMessage("second")!

		expect(queue.claimNextMessage()).toEqual(first)
		expect(queue.claimNextMessage()).toEqual(second)
		expect(queue.dequeueMessage()).toBeUndefined()
		expect(queue.messages).toEqual([first, second])
	})

	it("clears claim state when a message is removed or the queue is disposed", () => {
		const queue = new MessageQueueService()
		const message = queue.addMessage("feedback")!
		expect(queue.claimNextMessage()).toEqual(message)

		expect(queue.removeMessage(message.id)).toBe(true)
		expect(queue.removeMessage(message.id)).toBe(false)

		const next = queue.addMessage("next")!
		expect(queue.claimNextMessage()).toEqual(next)
		queue.dispose()
		expect(queue.messages).toEqual([])
		expect(queue.claimNextMessage()).toBeUndefined()
	})

	it("releases a claim without removing its durable payload", () => {
		const queue = new MessageQueueService()
		const message = queue.addMessage("retry later")!
		expect(queue.claimNextMessage()).toEqual(message)

		expect(queue.releaseMessage(message.id)).toBe(true)
		expect(queue.releaseMessage(message.id)).toBe(false)
		expect(queue.messages).toEqual([message])
		expect(queue.claimNextMessage()).toEqual(message)
	})
})
