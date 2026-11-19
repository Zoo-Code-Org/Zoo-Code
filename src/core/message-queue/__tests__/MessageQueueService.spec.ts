import { MessageQueueService } from "../MessageQueueService"

describe("MessageQueueService claims", () => {
	it("keeps claimed messages unavailable while later messages remain consumable", () => {
		const queue = new MessageQueueService()
		const first = queue.addMessage("first")!
		const second = queue.addMessage("second")!

		expect(queue.claimNextMessage()).toEqual(first)
		expect(queue.claimNextMessage()).toEqual(second)
		expect(queue.claimNextMessage()).toBeUndefined()
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

	it("reports no unclaimed message only when every queued message is spoken for", () => {
		const queue = new MessageQueueService()
		queue.addMessage("first")
		queue.addMessage("second")
		expect(queue.hasUnclaimed()).toBe(true)

		expect(queue.claimNextMessage()).toBeDefined()
		// One message held, one still available: a new consumer can still claim.
		expect(queue.hasUnclaimed()).toBe(true)

		expect(queue.claimNextMessage()).toBeDefined()
		// Both held: the queue is not empty, but nothing remains claimable.
		expect(queue.hasUnclaimed()).toBe(false)
	})

	it("pins isEmpty() to queue length so an outstanding claim does not empty it", () => {
		const queue = new MessageQueueService()
		const message = queue.addMessage("held")!
		expect(queue.claimNextMessage()).toEqual(message)

		// A claim is not a removal, so length-based emptiness still counts the
		// held message; consumers deciding whether they may take a message must
		// use hasUnclaimed() instead.
		expect(queue.isEmpty()).toBe(false)
		expect(queue.hasUnclaimed()).toBe(false)

		queue.releaseMessage(message.id)
		expect(queue.hasUnclaimed()).toBe(true)
	})

	it("skips excluded messages without claiming or removing them", () => {
		const queue = new MessageQueueService()
		const retained = queue.addMessage("retained by a drain")!
		const fresh = queue.addMessage("fresh")!
		const excluded = new Set([retained.id])

		// Availability must agree with the claim: the excluded message is not
		// available to this consumer even though the queue holds it.
		expect(queue.hasUnclaimed(excluded)).toBe(true)
		expect(queue.claimNextMessage(excluded)).toEqual(fresh)

		// The excluded message stays queued and unclaimed, so a consumer allowed
		// to take it (a conversational ask) still can.
		expect(queue.messages).toEqual([retained, fresh])
		expect(queue.hasUnclaimed(excluded)).toBe(false)
		expect(queue.claimNextMessage()).toEqual(retained)
	})

	it("reports no availability when every message is excluded", () => {
		const queue = new MessageQueueService()
		const only = queue.addMessage("only")!
		const excluded = new Set([only.id])

		expect(queue.hasUnclaimed(excluded)).toBe(false)
		expect(queue.claimNextMessage(excluded)).toBeUndefined()
		expect(queue.messages).toEqual([only])
	})
})
