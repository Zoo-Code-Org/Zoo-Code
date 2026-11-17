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
})

describe("MessageQueueService segments", () => {
	it("stores the segments with the message", () => {
		const queue = new MessageQueueService()
		const segments = [
			{ text: "ctx ", source: "generated" as const },
			{ text: "mine", source: "user" as const },
		]
		expect(queue.addMessage("ctx mine", undefined, segments)?.segments).toEqual(segments)
	})

	// Mirrors docs/architecture/tla/MentionOrigin.tla, QueueSave. The editor tags each input event.
	it("keeps the segments the editor sends", () => {
		const queue = new MessageQueueService()
		const message = queue.addMessage("ctx @/x", undefined, [{ text: "ctx @/x", source: "generated" }])!
		const segments = [
			{ text: "ctx @/x", source: "generated" as const },
			{ text: " mine", source: "user" as const },
		]

		queue.updateMessage(message.id, "ctx @/x mine", undefined, segments)

		expect(queue.messages[0]?.segments).toEqual(segments)
	})

	it.each([
		{ label: "omitted", segments: undefined },
		{ label: "not a list", segments: "user" },
		{ label: "a text mismatch", segments: [{ text: "other", source: "user" }] },
	])("fails closed when the edit segments are $label", ({ segments }) => {
		const queue = new MessageQueueService()
		const message = queue.addMessage("ctx @/x", undefined, [{ text: "ctx @/x", source: "generated" }])!

		queue.updateMessage(message.id, "@/x", undefined, segments)

		expect(queue.messages[0]?.segments).toEqual([{ text: "@/x", source: "generated" }])
	})

	// Mirrors docs/architecture/tla/QueueEditRace.tla, the guard on the late image resolve.
	describe("updateMessageImages", () => {
		it("sets the images when the text is unchanged", () => {
			const queue = new MessageQueueService()
			const message = queue.addMessage("see @/a.png")!

			expect(queue.updateMessageImages(message.id, "see @/a.png", ["data:a"])).toBe(true)
			expect(queue.messages[0]?.images).toEqual(["data:a"])
		})

		it("changes nothing when a later edit replaced the text", () => {
			const queue = new MessageQueueService()
			const message = queue.addMessage("see @/a.png")!
			queue.updateMessage(message.id, "see @/b.png")

			expect(queue.updateMessageImages(message.id, "see @/a.png", ["data:a"])).toBe(false)
			expect(queue.messages[0]?.images).toBeUndefined()
		})

		it("returns false when a drain removed the message", () => {
			const queue = new MessageQueueService()
			const message = queue.addMessage("see @/a.png")!
			queue.dequeueMessage()

			expect(queue.updateMessageImages(message.id, "see @/a.png", ["data:a"])).toBe(false)
		})
	})
})
