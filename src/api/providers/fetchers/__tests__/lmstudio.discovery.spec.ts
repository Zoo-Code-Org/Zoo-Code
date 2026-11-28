// Property test from docs/architecture/tla/LmStudioDiscovery.tla. It runs every answer order on the real code.
import axios, { AxiosError } from "axios"

import { getLMStudioModels } from "../lmstudio"

const get = vi.spyOn(axios, "get")
const baseUrl = "http://localhost:1234"
const paths = ["/api/v1/models", "/api/v0/models", "/v1/models"]
const emptyList = [{ models: [] }, { data: [] }, { data: [] }]

type Answer = "list" | "errbody" | "unsup" | "fatal"
type Stop = { kind: "cancel" | "timeout"; at: number } | undefined
type Case = { answers: Answer[]; stop: Stop }

const httpError = (status: number) =>
	new AxiosError("HTTP error", undefined, undefined, undefined, {
		status,
		statusText: "Error",
		data: {},
		headers: {},
		config: { headers: new axios.AxiosHeaders() },
	})

// The model of the spec. A stop at request k ends the run, whatever request k answers.
function reference({ answers, stop }: Case): { requests: number; outcome: string } {
	let firstMessage: string | undefined
	for (let k = 1; k <= 3; k++) {
		if (stop?.at === k) return { requests: k, outcome: stop.kind }
		const answer = answers[k - 1]
		if (answer === "list") return { requests: k, outcome: "ok" }
		if (answer === "fatal") return { requests: k, outcome: "status=500" }
		if (k < 3) {
			if (answer === "errbody") firstMessage ??= `E${k}`
			continue
		}
		return { requests: k, outcome: firstMessage ?? (answer === "errbody" ? "E3" : "status=404") }
	}
	throw new Error("unreachable")
}

// One case for each distinct run: answers after the end of a run do not matter.
const cases: Case[] = (() => {
	const all = new Map<string, Case>()
	const answers: Answer[] = ["list", "errbody", "unsup", "fatal"]
	const stops: Stop[] = [
		undefined,
		...[1, 2, 3].flatMap((at) => (["cancel", "timeout"] as const).map((kind) => ({ kind, at }))),
	]
	for (const a of answers)
		for (const b of answers)
			for (const c of answers)
				for (const stop of stops) {
					const used = reference({ answers: [a, b, c], stop }).requests
					// A stop after the last request never happens.
					const reached = stop && stop.at <= used ? stop : undefined
					const prefix = [a, b, c].slice(0, used)
					all.set(JSON.stringify([prefix, reached]), { answers: prefix, stop: reached })
				}
	return [...all.values()]
})()

const consoleError = vi.spyOn(console, "error")
vi.spyOn(console, "warn").mockImplementation(() => {})

beforeEach(() => {
	get.mockReset()
	consoleError.mockReset().mockImplementation(() => {})
})

describe("discovery answer orders", () => {
	it.each(cases.map((c) => [JSON.stringify(c), c] as const))("%s", async (_name, testCase) => {
		const { answers, stop } = testCase
		const expected = reference(testCase)
		const caller = new AbortController()
		const deadline = new AbortController()
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
		try {
			get.mockImplementation(async (url) => {
				const k = paths.findIndex((path) => url === `${baseUrl}${path}`) + 1
				if (stop?.at === k) {
					if (stop.kind === "cancel") caller.abort()
					else deadline.abort(new DOMException("deadline", "TimeoutError"))
					throw new AxiosError("stopped", "ERR_CANCELED")
				}
				const answer = answers[k - 1]
				if (answer === "list") return { data: emptyList[k - 1] }
				if (answer === "errbody") return { data: { error: `E${k}` } }
				throw httpError(answer === "unsup" ? 404 : 500)
			})

			const run = getLMStudioModels(baseUrl, { signal: caller.signal, commit: false })
			if (stop?.kind === "cancel") await expect(run).rejects.toMatchObject({ name: "AbortError" })
			else await run

			// NoRequestAfterStop and OnlyUnsupportedFallsBack: the run asks the first endpoints in order, and no more.
			expect(get.mock.calls.map(([url]) => url)).toEqual(
				paths.slice(0, expected.requests).map((path) => `${baseUrl}${path}`),
			)
			// FirstMessage and OkIsList: an error names its cause. A success logs no error.
			const logged = consoleError.mock.calls.map((call) => String(call[1] ?? call[0]))
			if (expected.outcome === "ok" || expected.outcome === "cancel") expect(logged).toEqual([])
			else if (expected.outcome === "timeout") expect(logged).toEqual([expect.stringContaining("timed out")])
			else expect(logged).toEqual([expect.stringContaining(expected.outcome)])
		} finally {
			timeout.mockRestore()
		}
	})
})
