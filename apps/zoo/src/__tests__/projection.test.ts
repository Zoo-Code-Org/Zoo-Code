import { describe, expect, it } from "vitest"

import { initialProjection, reduceSession } from "../projection.js"

const base = { v: 1 as const, seq: 1, timestamp: "2026-08-05T12:00:00.000Z", hostId: "host" }

describe("SessionProjection", () => {
	it("upserts messages by canonical identity", () => {
		const created = reduceSession(initialProjection(), {
			...base,
			type: "message.upsert",
			rootTaskId: "root",
			taskId: "root",
			messageId: "message-1",
			role: "assistant",
			content: "hel",
			complete: false,
		})
		const updated = reduceSession(created, {
			...base,
			seq: 2,
			type: "message.upsert",
			rootTaskId: "root",
			taskId: "root",
			messageId: "message-1",
			role: "assistant",
			content: "hello",
			complete: true,
		})

		expect([...updated.messages.values()]).toEqual([{ role: "assistant", content: "hello", complete: true }])
		expect(created.messages.get("message-1")?.content).toBe("hel")
	})
})
