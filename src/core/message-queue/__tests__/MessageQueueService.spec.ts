import { MessageQueueService } from "../MessageQueueService"

describe("MessageQueueService", () => {
	it("keeps queue and steer lanes separate while exposing steer-first ordering", () => {
		const service = new MessageQueueService()

		const queued = service.addMessage("queued", undefined, "queue")
		const steer = service.addMessage("steer", undefined, "steer")

		expect(service.messages.map((message) => message.text)).toEqual(["steer", "queued"])
		expect(service.getMessagesByMode("queue")).toEqual([queued])
		expect(service.getMessagesByMode("steer")).toEqual([steer])

		expect(service.dequeueMessageByMode("queue")?.text).toBe("queued")
		expect(service.dequeueMessageByMode("steer")?.text).toBe("steer")
		expect(service.isEmpty()).toBe(true)
	})

	it("can move messages between lanes without losing timestamps or images", () => {
		const service = new MessageQueueService()
		const message = service.addMessage("queued", ["image.png"], "queue")

		expect(message).toBeDefined()
		expect(service.updateMessage(message!.id, "steer now", ["image.png"], "steer")).toBe(true)

		expect(service.getMessagesByMode("queue")).toEqual([])
		expect(service.getMessagesByMode("steer")).toEqual([
			expect.objectContaining({
				id: message!.id,
				text: "steer now",
				images: ["image.png"],
				deliveryMode: "steer",
				createdAt: message!.createdAt,
			}),
		])
	})
})
