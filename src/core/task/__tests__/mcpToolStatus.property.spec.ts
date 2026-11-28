// Property test for docs/architecture/tla/McpToolStatus.tla: LatestWins and Fresh.
import type { McpToolStatus } from "@roo-code/types"
import { McpToolStatusTracker } from "../mcpToolStatus"

const results: (McpToolStatus | null)[] = [
	null,
	{ attachedToolNames: ["mcp--s--a"], totalScoped: 60 },
	{ attachedToolNames: ["mcp--s--b"], totalScoped: 60 },
]

type Step = { kind: "begin" } | { kind: "finish"; build: number; result: McpToolStatus | null }

/** Every interleaving of three builds, with each possible result. */
function* schedules(steps: Step[] = [], started = 0, pending: number[] = []): Generator<Step[]> {
	if (started === 3 && pending.length === 0) {
		yield steps
		return
	}
	if (started < 3) yield* schedules([...steps, { kind: "begin" }], started + 1, [...pending, started])
	for (const build of pending) {
		const rest = pending.filter((other) => other !== build)
		for (const result of results) {
			yield* schedules([...steps, { kind: "finish", build, result }], started, rest)
		}
	}
}

describe("McpToolStatusTracker", () => {
	it("keeps the newest result and publishes each change in every schedule", () => {
		let checked = 0
		for (const schedule of schedules()) {
			let published: McpToolStatus | null = null
			const tracker: McpToolStatusTracker = new McpToolStatusTracker(() => (published = tracker.value))
			const reports: ((status: McpToolStatus | null) => void)[] = []
			const finished = new Map<number, McpToolStatus | null>()
			for (const step of schedule) {
				if (step.kind === "begin") {
					reports.push(tracker.begin())
				} else {
					reports[step.build](step.result)
					finished.set(step.build, step.result)
				}
				// LatestWins: it holds from the end of the newest build until the next build starts.
				const newest = reports.length - 1
				if (finished.has(newest)) expect(tracker.value).toEqual(finished.get(newest))
				expect(published).toEqual(tracker.value)
			}
			checked++
		}
		expect(checked).toBeGreaterThan(100)
	})
})
