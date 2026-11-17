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

// Runs one whole edit the way the handler does.
const edit = (queue: MessageQueueService, id: string, text: string, images?: string[], segments?: unknown) =>
	queue.commitEdit(id, queue.beginEdit(id)!, text, images, segments)

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

		edit(queue, message.id, "ctx @/x mine", undefined, segments)

		expect(queue.messages[0]?.segments).toEqual(segments)
	})

	it.each([
		{ label: "omitted", segments: undefined },
		{ label: "not a list", segments: "user" },
		{ label: "a text mismatch", segments: [{ text: "other", source: "user" }] },
	])("fails closed when the edit segments are $label", ({ segments }) => {
		const queue = new MessageQueueService()
		const message = queue.addMessage("ctx @/x", undefined, [{ text: "ctx @/x", source: "generated" }])!

		edit(queue, message.id, "@/x", undefined, segments)

		expect(queue.messages[0]?.segments).toEqual([{ text: "@/x", source: "generated" }])
	})

	// Mirrors docs/architecture/tla/QueueEditRace.tla, mode Claim.
	describe("edits", () => {
		const queued = () => {
			const queue = new MessageQueueService()
			const message = queue.addMessage(
				"see @/a.png",
				["data:old"],
				[{ text: "see @/a.png", source: "generated" }],
			)!
			return { queue, id: message.id }
		}

		it("commits text, segments and images together", () => {
			const { queue, id } = queued()
			const token = queue.beginEdit(id)!
			const segments = [{ text: "see @/b.png", source: "user" as const }]

			expect(queue.commitEdit(id, token, "see @/b.png", ["data:b"], segments)).toBe(true)
			expect(queue.messages[0]).toMatchObject({ text: "see @/b.png", images: ["data:b"], segments })
		})

		it("keeps the message from a drain until the edit commits", () => {
			const { queue, id } = queued()
			const token = queue.beginEdit(id)!

			expect(queue.dequeueMessage()).toBeUndefined()
			expect(queue.hasUnclaimed()).toBe(false)

			queue.commitEdit(id, token, "see @/b.png", [])
			expect(queue.dequeueMessage()).toMatchObject({ text: "see @/b.png" })
		})

		it("emits a state change on commit so a waiting consumer sees the message again", () => {
			const { queue, id } = queued()
			const token = queue.beginEdit(id)!
			const changed = vi.fn()
			queue.on("stateChanged", changed)

			queue.commitEdit(id, token, "see @/b.png", [])
			expect(changed).toHaveBeenCalledTimes(1)
			expect(queue.hasUnclaimed()).toBe(true)
		})

		it("lets only the newest edit commit, even when the text is the same", () => {
			const { queue, id } = queued()
			const first = queue.beginEdit(id)!
			const second = queue.beginEdit(id)!
			const asUser = [{ text: "same", source: "user" as const }]
			const asGenerated = [{ text: "same", source: "generated" as const }]

			expect(queue.commitEdit(id, second, "same", ["data:second"], asGenerated)).toBe(true)
			expect(queue.commitEdit(id, first, "same", ["data:first"], asUser)).toBe(false)
			expect(queue.messages[0]).toMatchObject({ images: ["data:second"], segments: asGenerated })
		})

		it("ignores an older edit that ends first, and holds the message for the newer one", () => {
			const { queue, id } = queued()
			const first = queue.beginEdit(id)!
			queue.beginEdit(id)

			expect(queue.commitEdit(id, first, "late", [])).toBe(false)
			expect(queue.dequeueMessage()).toBeUndefined()
		})

		it("gives no token when the message is gone or a consumer holds it", () => {
			const { queue, id } = queued()
			queue.claimNextMessage()
			expect(queue.beginEdit(id)).toBeUndefined()

			queue.removeMessage(id)
			expect(queue.beginEdit(id)).toBeUndefined()
		})

		it("fails a commit after the message was removed", () => {
			const { queue, id } = queued()
			const token = queue.beginEdit(id)!
			queue.removeMessage(id)

			expect(queue.commitEdit(id, token, "late", [])).toBe(false)
		})
	})
})
