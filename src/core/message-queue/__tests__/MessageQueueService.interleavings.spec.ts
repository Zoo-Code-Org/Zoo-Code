import type { QueuedMessage } from "@roo-code/types"

import { MessageQueueService } from "../MessageQueueService"

// Explores every order of edits, consumer claims, late messages and drain calls on the real service.
// It checks the invariants of docs/architecture/tla/QueueDrainRetry.tla. The model is an abstraction.
// This test runs the code.
const INITIAL = 2
const TOTAL = 3
const MAX_CALLS = 2

type Action =
	| { kind: "late" }
	| { kind: "call" }
	| { kind: "claim" }
	| { kind: "begin" | "commit" | "remove" | "release" | "consume"; i: number }

class World {
	service = new MessageQueueService()
	ids: string[] = []
	editing = new Map<string, number>()
	consumerHeld = new Set<string>()
	sent = new Set<string>()
	seen = new Set<string>()
	calls = 0
	ghost: Set<string>[] = []

	constructor() {
		for (let i = 0; i < INITIAL; i++) this.ids.push(this.service.addMessage(`m${i}`)!.id)
		this.service.on("drained", (message: QueuedMessage) => this.sent.add(message.id))
	}

	private alive(id: string) {
		return this.service.messages.some((message) => message.id === id)
	}

	private queued(id: string) {
		return this.alive(id) && !this.editing.has(id) && !this.consumerHeld.has(id)
	}

	apply(action: Action): boolean {
		const id = "i" in action ? this.ids[action.i] : undefined
		switch (action.kind) {
			case "late":
				if (this.ids.length >= TOTAL) return false
				this.ids.push(this.service.addMessage("late")!.id)
				return true
			case "begin": {
				if (!id) return false
				const token = this.service.beginEdit(id)
				if (token === undefined) return false
				this.editing.set(id, token)
				return true
			}
			case "commit": {
				if (!id || !this.editing.has(id)) return false
				this.service.commitEdit(id, this.editing.get(id)!, "edited")
				this.editing.delete(id)
				return true
			}
			case "remove": {
				if (!id || !this.alive(id)) return false
				this.service.removeMessage(id)
				this.editing.delete(id)
				this.consumerHeld.delete(id)
				return true
			}
			case "claim": {
				const message = this.service.claimNextMessage()
				if (!message) return false
				this.consumerHeld.add(message.id)
				return true
			}
			case "release":
			case "consume": {
				if (!id || !this.consumerHeld.has(id)) return false
				this.consumerHeld.delete(id)
				if (action.kind === "release") this.service.releaseMessage(id)
				else this.service.removeMessage(id)
				return true
			}
			case "call": {
				if (this.calls >= MAX_CALLS) return false
				this.calls++
				for (const message of this.service.messages) this.seen.add(message.id)
				const message = this.service.drain()
				if (message) this.sent.add(message.id)
				else if (this.editing.size > 0) this.ghost.push(new Set(this.editing.keys()))
				return true
			}
		}
	}

	// A snapshot ends when one of its messages is sent or all of them are gone.
	violation(): string | undefined {
		for (const id of this.sent) if (!this.seen.has(id)) return `sent ${id} that no call saw`
		if (this.sent.size > this.calls) return "more sends than calls"
		this.ghost = this.ghost.filter(
			(s) => ![...s].some((id) => this.sent.has(id)) && [...s].some((id) => this.alive(id)),
		)
		for (const s of this.ghost) {
			const waiting = [...s].some((id) => this.editing.has(id) || this.consumerHeld.has(id))
			if (!waiting && [...s].some((id) => this.queued(id))) return "a blocked drain left its message queued"
		}
		return undefined
	}

	// Random ids differ on each replay. The key uses the message index.
	key(): string {
		const q = this.service
		const ix = (id: string) => this.ids.indexOf(id)
		const sorted = (ids: Iterable<string>) => [...ids].map(ix).sort()
		return JSON.stringify([
			q.messages.map((m) => ix(m.id)),
			sorted(q["claimedMessageIds"]),
			sorted(q["editTokens"].keys()),
			q["blockedDrains"].map((ids) => sorted(ids)),
			this.ids.length,
			sorted(this.consumerHeld),
			sorted(this.sent),
			sorted(this.seen),
			this.calls,
			this.ghost.map((s) => sorted(s)),
		])
	}
}

const actions = (): Action[] => [
	{ kind: "late" },
	{ kind: "call" },
	{ kind: "claim" },
	...(["begin", "commit", "remove", "release", "consume"] as const).flatMap((kind) =>
		Array.from({ length: TOTAL }, (_, i) => ({ kind, i })),
	),
]

function replay(path: Action[]): World {
	const world = new World()
	for (const action of path) world.apply(action)
	return world
}

// Breadth-first over distinct states. Each state is rebuilt by replay, so it uses only the public API.
function explore(): { states: number; failure?: { path: Action[]; why: string } } {
	const seen = new Set<string>([new World().key()])
	let frontier: Action[][] = [[]]
	while (frontier.length > 0) {
		const next: Action[][] = []
		for (const path of frontier) {
			for (const action of actions()) {
				const world = replay(path)
				if (!world.apply(action)) continue
				const why = world.violation()
				if (why) return { states: seen.size, failure: { path: [...path, action], why } }
				const key = world.key()
				if (!seen.has(key)) {
					seen.add(key)
					next.push([...path, action])
				}
			}
		}
		frontier = next
	}
	return { states: seen.size }
}

describe("MessageQueueService drain interleavings", () => {
	it("keeps both invariants in every order", () => {
		const result = explore()
		expect(result.failure).toBeUndefined()
		expect(result.states).toBeGreaterThan(500)
	})

	it("finds the failure when a retry sends the first queued message", () => {
		const proto = MessageQueueService.prototype
		const original = proto["serveBlockedDrains"]
		proto["serveBlockedDrains"] = function (this: MessageQueueService) {
			const pending = this["blockedDrains"]
			this["blockedDrains"] = []
			for (const ids of pending) {
				const live = this.messages.filter((m) => ids.includes(m.id))
				if (live.length === 0) continue
				if (live.every((m) => this["claimedMessageIds"].has(m.id))) this["blockedDrains"].push(ids)
				else {
					const next = this.dequeueMessage()
					if (next) this.emit("drained", next)
				}
			}
		}
		try {
			expect(explore().failure?.why).toBe("a blocked drain left its message queued")
		} finally {
			proto["serveBlockedDrains"] = original
		}
	})
})
