import assert from "node:assert/strict"

import { MessageQueueService } from "../src/core/message-queue/MessageQueueService"
import { initialRunState, nextRunState, type RunEvent, type RunState } from "../src/core/task/run-state/runState"

// Bounded model of where a queued message lands after the queue hands it to the task (#2421, finding V2).
// Real code: MessageQueueService (drain, beginEdit, commitEdit, claimNextMessage, the "drained" event) and
// the run-state kernel nextRunState (ask pending or not).
// Model abstractions, not imported code, because Task.ts needs VS Code:
// - the askResponse slot: Task.handleWebviewAskResponse sets it with no check for a pending ask,
//   and every Task.ask() start resets it (Task.ts around L2063-2116);
// - the setTimeout(0) between a drain and Task.submitUserMessage, kept as an in-flight list.
// The queue is replayed from the action list for each state, because the service is mutable.
// Command policy, protected asks, message text and aborted tasks are outside this model.

type Action = "add-a" | "add-b" | "edit-a" | "commit-a" | "drain" | "deliver" | "ask" | "consume"

interface Policy {
	name: string
	// How Task.submitQueuedMessage lands a message that reaches the slot.
	land: "always-set" | "set-if-ask-pending" | "requeue-unless-ask-and-empty-slot"
}

const production: Policy = { name: "production", land: "always-set" }
// Proposed fix: set the slot only when an ask waits and the slot is empty. Otherwise keep the message queued.
const requeue: Policy = { name: "requeue-unless-ask-and-empty-slot", land: "requeue-unless-ask-and-empty-slot" }
// Injected unsafe fix: checks the ask but not the slot, so a second message overwrites the first.
const askOnly: Policy = { name: "set-if-ask-pending", land: "set-if-ask-pending" }

const MAX_DEPTH = 10
const MAX_STATES = 50_000
const ACTIONS: Action[] = ["add-a", "add-b", "edit-a", "commit-a", "drain", "deliver", "ask", "consume"]

class World {
	readonly queue = new MessageQueueService()
	run: RunState = initialRunState
	slot: string | undefined
	readonly inflight: string[] = []
	readonly consumed: string[] = []
	readonly lost: string[] = []
	readonly added: string[] = []
	private token: number | undefined
	private askTs = 0
	readonly tags = new Set<string>()

	constructor(private readonly policy: Policy) {
		this.event({ tag: "initialized" })
		this.queue.on("drained", (message) => {
			this.tags.add("drained-event")
			this.inflight.push(message.text)
		})
	}

	private event(event: RunEvent): void {
		const result = nextRunState(this.run, event)
		assert.ok("ok" in result, `run-state rejected ${event.tag}`)
		this.run = result.ok
	}

	private askPending(): boolean {
		return this.run.ask.tag !== "none"
	}

	private text(id: string): string | undefined {
		return this.queue.messages.find((message) => message.id === id)?.text
	}

	private idOf(text: string): string | undefined {
		return this.queue.messages.find((message) => message.text === text)?.id
	}

	// Task.handleWebviewAskResponse after submitUserMessage.
	private land(text: string): void {
		const { land } = this.policy
		const askPending = this.askPending()
		const slotFull = this.slot !== undefined
		if (land === "requeue-unless-ask-and-empty-slot" && (!askPending || slotFull)) {
			this.queue.addMessage(text)
			this.tags.add(askPending ? "requeued-slot-full" : "requeued-no-ask")
			return
		}
		if (land === "set-if-ask-pending" && !askPending) {
			this.queue.addMessage(text)
			return
		}
		if (this.slot !== undefined) {
			this.lost.push(this.slot)
		}
		this.slot = text
	}

	enabled(action: Action): boolean {
		switch (action) {
			case "add-a":
				return !this.added.includes("a")
			case "add-b":
				return !this.added.includes("b")
			case "edit-a":
				return this.idOf("a") !== undefined && this.token === undefined
			case "commit-a":
				return this.token !== undefined
			case "drain":
				return !this.queue.isEmpty()
			case "deliver":
				return this.inflight.length > 0
			case "ask":
				return !this.askPending() && this.askTs < 2
			case "consume":
				return this.askPending() && this.slot !== undefined
		}
	}

	apply(action: Action): void {
		switch (action) {
			case "add-a":
			case "add-b": {
				const text = action.slice(-1)
				this.added.push(text)
				this.queue.addMessage(text)
				return
			}
			case "edit-a":
				this.token = this.queue.beginEdit(this.idOf("a")!)
				return
			case "commit-a": {
				const id = this.idOf("a")
				if (id !== undefined && this.token !== undefined) this.queue.commitEdit(id, this.token, "a")
				this.token = undefined
				return
			}
			case "drain": {
				// Task.processQueuedMessages: drain, then submitQueuedMessage defers through setTimeout(0).
				const message = this.queue.drain()
				if (message) this.inflight.push(message.text)
				return
			}
			case "deliver":
				this.land(this.inflight.shift()!)
				return
			case "ask": {
				// Task.ask() resets the slot, then the ask loop claims a queued message.
				if (this.slot !== undefined) {
					this.lost.push(this.slot)
					this.slot = undefined
				}
				this.askTs += 1
				this.event({ tag: "askStarted", ask: { tag: "other", askTs: this.askTs } })
				const claimed = this.queue.claimNextMessage()
				if (claimed) {
					this.queue.removeMessage(claimed.id)
					this.consumed.push(claimed.text)
					this.event({ tag: "askSettled", askTs: this.askTs })
				}
				return
			}
			case "consume": {
				this.consumed.push(this.slot!)
				this.slot = undefined
				this.event({ tag: "askSettled", askTs: this.askTs })
				return
			}
		}
	}

	violation(): string | undefined {
		if (this.lost.length > 0) return `message ${this.lost[0]} was dropped`
		const places = [
			...this.queue.messages.map((message) => message.text),
			...(this.slot === undefined ? [] : [this.slot]),
			...this.inflight,
			...this.consumed,
		]
		for (const text of this.added) {
			const count = places.filter((place) => place === text).length
			if (count === 0) return `message ${text} is nowhere`
			if (count > 1) return `message ${text} is in ${count} places`
		}
		return undefined
	}

	canonical(): string {
		return JSON.stringify({
			queue: this.queue.messages.map((message) => message.text),
			claimed: [...(this.queue["claimedMessageIds"] as Set<string>)].map((id) => this.text(id) ?? "?").sort(),
			edits: [...(this.queue["editTokens"] as Map<string, number>).keys()].map((id) => this.text(id) ?? "?"),
			blocked: (this.queue["blockedDrains"] as string[][]).map((ids) => ids.map((id) => this.text(id) ?? "?")),
			slot: this.slot,
			inflight: this.inflight,
			consumed: this.consumed,
			ask: this.run.ask.tag,
			added: this.added,
			editing: this.token !== undefined,
			asks: this.askTs,
			// Landmarks stay in the key, so a path that reaches one is not merged with a path that does not.
			tags: [...this.tags].sort(),
		})
	}
}

function replay(policy: Policy, trace: Action[]): World {
	const world = new World(policy)
	for (const action of trace) world.apply(action)
	return world
}

interface Exploration {
	violation?: { message: string; trace: Action[] }
	states: number
	tags: Set<string>
}

function explore(policy: Policy): Exploration {
	const queue: Action[][] = [[]]
	const visited = new Set<string>([new World(policy).canonical()])
	const tags = new Set<string>()
	for (let index = 0; index < queue.length; index++) {
		const trace = queue[index]!
		const world = replay(policy, trace)
		world.tags.forEach((tag) => tags.add(tag))
		const found = world.violation()
		if (found) return { violation: { message: found, trace }, states: visited.size, tags }
		if (trace.length === MAX_DEPTH) continue
		for (const action of ACTIONS) {
			if (!world.enabled(action)) continue
			const next = [...trace, action]
			const key = replay(policy, next).canonical()
			if (visited.has(key)) continue
			visited.add(key)
			queue.push(next)
			if (visited.size > MAX_STATES) throw new Error(`Queue landing model exceeded ${MAX_STATES} states`)
		}
	}
	return { states: visited.size, tags }
}

const format = (trace: Action[]): string => trace.map((action, index) => `${index + 1}. ${action}`).join("\n")

// The proposed fix must be clean, with every landmark reachable.
const fixed = explore(requeue)
assert.equal(
	fixed.violation,
	undefined,
	`Queue landing invariant failed under ${requeue.name}: ${fixed.violation?.message}\n${format(fixed.violation?.trace ?? [])}`,
)
const landmarks = ["drained-event", "requeued-no-ask"]
const missing = landmarks.filter((tag) => !fixed.tags.has(tag))
assert.deepEqual(missing, [], `Queue landing model has unreachable landmarks: ${missing.join(", ")}`)

// Injected unsafe policy: it must fail, so the invariant can see an overwrite.
const unsafe = explore(askOnly)
assert.ok(unsafe.violation, `Injected policy ${askOnly.name} must violate the invariant`)

// Known gap (#2421 finding V2): production sets the slot with no ask pending, and the next ask() drops it.
// The requeue policy above is the proposed fix. This witness keeps the gap visible until production changes.
const gap = explore(production)
assert.ok(gap.violation, "Known queue landing gap no longer reproduces: update the model and the document")

console.log(
	`Queue landing model check passed: ${fixed.states} reachable states under ${requeue.name}, ${landmarks.length}/${landmarks.length} landmarks, depth <= ${MAX_DEPTH}`,
)
console.log(
	`Known-unsafe witness: ${askOnly.name} (${unsafe.violation!.trace.length} steps: ${unsafe.violation!.message})`,
)
console.log(
	`Known gap (message sent with no ask pending): ${gap.violation!.message} after ${gap.violation!.trace.length} steps\n${format(gap.violation!.trace)}`,
)
