// pnpm exec vitest run api/providers/utils/__tests__/invoke-recovery.spec.ts

import { InvokeRecoveryScanner, offeredToolNames, type RecoveryEvent } from "../invoke-recovery"

const WEATHER_TOOLS = new Set(["get_weather", "write_to_file", "read_file"])

const weatherCall = (location: string) =>
	`<function_calls><invoke name="get_weather"><parameter name="location">${location}</parameter></invoke></function_calls>`

const bareWeatherCall = (location: string) =>
	`<invoke name="get_weather"><parameter name="location">${location}</parameter></invoke>`

/** Splits `text` into `n` roughly equal chunks and scans them in order. */
function scanChunked(text: string, chunkSizes: number[], tools = WEATHER_TOOLS): RecoveryEvent[] {
	const scanner = new InvokeRecoveryScanner(tools)
	const events: RecoveryEvent[] = []
	let at = 0
	for (const size of chunkSizes) {
		events.push(...scanner.onText(text.slice(at, at + size)))
		at += size
	}
	if (at < text.length) {
		events.push(...scanner.onText(text.slice(at)))
	}
	events.push(...scanner.finish())
	return events
}

const text = (events: RecoveryEvent[]) =>
	events
		.filter((event): event is Extract<RecoveryEvent, { kind: "text" }> => event.kind === "text")
		.map((event) => event.text)
		.join("")

const calls = (events: RecoveryEvent[]) =>
	events.filter((event): event is Extract<RecoveryEvent, { kind: "call" }> => event.kind === "call")

describe("InvokeRecoveryScanner", () => {
	it("recovers a wrapped invoke block and drops the wrapper tags", () => {
		const events = scanChunked(`Running now ${weatherCall("Berlin")}\ndone`, [11, 40, 20])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Berlin"}' }])
		expect(text(events)).toBe("Running now \ndone")
	})

	it("recovers a bare invoke block without a wrapper", () => {
		const events = scanChunked(`Hmm. ${bareWeatherCall("Rome")} Ok.`, [5, 30, 10])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe("Hmm.  Ok.")
	})

	// Chunk-split invariance (property test): the events for a response
	// must not depend on where the deltas split the bytes. Compare the
	// joined text and the calls; text CHUNK shapes may differ with the
	// delta sizes by design.
	const invarianceFixtures = [
		`Running now ${weatherCall("Berlin")}\ndone`,
		`plain prose only, no markers at all`,
		`a < b and c > d with stray brackets`,
		`${bareWeatherCall("Rome")} tail`,
		`Example:\n\`\`\`text\n${weatherCall("Berlin")}\n\`\`\`\nDone`,
		`~~~\n${bareWeatherCall("Rome")}\n~~~`,
		`look \`<invoke name="get_weather"><parameter name="location">x</parameter></invoke>\` inline`,
		`<invoke name="unknown_tool"><parameter name="a">b</parameter></invoke>`,
		`<function_calls><invoke name="get_weather"><parameter name="location">Berlin</parameter>`,
		`A ${weatherCall("Berlin")} B ${bareWeatherCall("Rome")} C`,
		`<function_calls>\njust prose in a wrapper\n`,
		`2 < 3 <inv partial that never closes`,
	]
	const normalize = (events: RecoveryEvent[]) => ({
		text: text(events),
		calls: calls(events),
	})
	const splitSizes = [1, 2, 3, 7, 16, 64] as const

	it.each(
		invarianceFixtures.flatMap((fixture, index) =>
			splitSizes.map((size) => [`fixture ${index} split at ${size}`, fixture, size] as const),
		),
	)("keeps the sink identical for %s", (_label, fixture, size) => {
		const whole = normalize(scanChunked(fixture, [fixture.length]))
		const sizes: number[] = []
		for (let at = 0; at < fixture.length; at += size) {
			sizes.push(size)
		}
		expect(normalize(scanChunked(fixture, sizes))).toStrictEqual(whole)
	})

	it("emits prose before the marker immediately, byte for byte", () => {
		// LiveStream: text outside a hold reaches the caller as soon as it
		// arrives; only the marker candidate may wait.
		const scanner = new InvokeRecoveryScanner(WEATHER_TOOLS)
		expect(scanner.onText("Hello ")).toStrictEqual([{ kind: "text", text: "Hello " }])
		expect(scanner.onText("wor ")).toStrictEqual([{ kind: "text", text: "wor " }])
		expect(scanner.onText("<fun")).toStrictEqual([])
		expect(scanner.onText("ction_calls>")).toStrictEqual([])
		const rest = scanner.finish()
		expect(text(rest)).toContain("<fun")
		expect(text(scanner.onText("x"))).toBe("x")
	})

	it("keeps a fence-quoted invoke block as text (backtick fence)", () => {
		const events = scanChunked(`Example:\n\`\`\`text\n${weatherCall("Berlin")}\n\`\`\`\nDone`, [9, 30, 30])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(`Example:\n\`\`\`text\n${weatherCall("Berlin")}\n\`\`\`\nDone`)
	})

	it("keeps a tilde-fence-quoted invoke block as text", () => {
		const events = scanChunked(`~~~\n${bareWeatherCall("Rome")}\n~~~`, [4, 30, 4])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(`~~~\n${bareWeatherCall("Rome")}\n~~~`)
	})

	it("keeps an inline-code-span-quoted invoke block as text", () => {
		const quoted = bareWeatherCall("Rome")
		const events = scanChunked(`use \`markup ${quoted}\` verbatim`, [6, 40, 10])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(`use \`markup ${quoted}\` verbatim`)
	})

	it("does not treat a backtick fence line with a backtick info string as a fence opener", () => {
		// CommonMark: a backtick fence's info string must contain no
		// backtick, so ```lang`value is prose and its runs are span markers.
		const events = scanChunked("```lang`value\nplain\n```\nrest", [8, 10, 10])
		expect(calls(events)).toStrictEqual([])
	})

	it("keeps an unknown tool name as text", () => {
		const events = scanChunked(
			`<invoke name="unknown_tool"><parameter name="a">b</parameter></invoke>`,
			[10, 30, 30],
			new Set(["get_weather"]),
		)
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(`<invoke name="unknown_tool"><parameter name="a">b</parameter></invoke>`)
	})

	it("flushes an unterminated block as text at finish", () => {
		const held = `<function_calls><invoke name="get_weather"><parameter name="location">Berlin</parameter>`
		const events = scanChunked(`before ${held}`, [7, 100])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(`before ${held}`)
	})

	it("keeps a wrapper without an invoke as text", () => {
		const events = scanChunked(`<function_calls>\njust prose here\n`, [16, 20])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(`<function_calls>\njust prose here\n`)
	})

	it("recovers each block of a multi-call response and keeps inter-text", () => {
		const fixture = `A ${weatherCall("Berlin")} B ${bareWeatherCall("Rome")} C`
		const events = scanChunked(fixture, [2, 40, 3, 40, 3])
		expect(calls(events)).toStrictEqual([
			{ kind: "call", name: "get_weather", arguments: '{"location":"Berlin"}' },
			{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' },
		])
		expect(text(events)).toBe("A  B  C")
	})

	it("streams text through a stray angle bracket without holding", () => {
		const events = scanChunked("2 < 3 and 5 > 4 with no markers", [5, 30])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe("2 < 3 and 5 > 4 with no markers")
	})

	it("parses multi-parameter bodies in written order", () => {
		const fixture =
			`<invoke name="write_to_file"><parameter name="path">prova.txt</parameter>` +
			`<parameter name="content">test</parameter></invoke>`
		const events = scanChunked(fixture, [10, 40, 40])
		expect(calls(events)).toStrictEqual([
			{ kind: "call", name: "write_to_file", arguments: '{"path":"prova.txt","content":"test"}' },
		])
		expect(text(events)).toBe("")
	})

	it("recovers across fence-adjacent whitespace inside the wrapper skeleton", () => {
		const fixture = `<function_calls>\n<invoke name="get_weather"><parameter name="location">Berlin</parameter></invoke>\n</function_calls>`
		const events = scanChunked(fixture, [17, 40, 30])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Berlin"}' }])
		expect(text(events)).toBe("")
	})

	it("re-scans a falsified marker candidate and recovers a later block", () => {
		const fixture = `<invalid prose ${weatherCall("Berlin")}`
		const events = scanChunked(fixture, [3, 20, 40])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Berlin"}' }])
		expect(text(events)).toBe("<invalid prose ")
	})

	it("offeredToolNames reads only usable function tools", () => {
		const tools = [
			{ type: "function" as const, function: { name: "get_weather" } },
			{ type: "function" as const, function: {} },
			{ type: "prompt" as const, function: { name: "nope" } },
		] as unknown as Parameters<typeof offeredToolNames>[0]
		expect(offeredToolNames(tools)).toStrictEqual(new Set(["get_weather"]))
		expect(offeredToolNames(undefined)).toStrictEqual(new Set())
	})
})
