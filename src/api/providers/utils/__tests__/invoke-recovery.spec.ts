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

	it("drops only the first wrapper close behind a recovered call", () => {
		// Only the closer next to the block is skeleton residue. A second
		// closer falls outside the wrapper-only drop rule and flows
		// through prose scanning as text.
		const fixture = `${bareWeatherCall("Rome")}</function_calls></function_calls>X`
		const events = scanChunked(fixture, [30, 20, 10])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe("</function_calls>X")
	})

	it("recovers a bare invoke block without a wrapper", () => {
		const events = scanChunked(`Hmm. ${bareWeatherCall("Rome")} Ok.`, [5, 30, 10])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe("Hmm.  Ok.")
	})

	it("recovers a bare parameterless invoke block with empty arguments", () => {
		// No <parameter> pairs parse to an empty arguments object: the
		// recovered call carries `{}`.
		const events = scanChunked(`Before <invoke name="get_weather"></invoke> after`, [7, 30, 6])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: "{}" }])
		expect(text(events)).toBe("Before  after")
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
		`~~~\n> ~~~\n${bareWeatherCall("Rome")}\n~~~`,
		`> ~~~\n> example\n\n${bareWeatherCall("Rome")}`,
		`> ~~~\n>\t ~~~\n> ~~~\n> ${bareWeatherCall("Rome")}\n> ~~~`,
		`> > ~~~
>\t  > example
${bareWeatherCall("Rome")}`,
		`> > ~~~
>\t > example
> > ${bareWeatherCall("Rome")}
> > ~~~`,
		`- ~~~\n  ${bareWeatherCall("Rome")}\n  ~~~\nafter`,
		`<invoke name="write_to_file"><parameter name="content">line1
~~~
line2</parameter></invoke><invoke name="read_file"><parameter name="path">a.ts</parameter></invoke>`,
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
	it("recovers a following bare call after a recovered value that embeds a fence", () => {
		// A recovered parameter value is tool input, not surrounding
		// Markdown: the fence marker inside the content value must not
		// open a fence in the scanner's context, or the next bare block
		// is wrongly quoted and stays text.
		const fixture =
			`<invoke name="write_to_file"><parameter name="content">line1\n~~~\nline2</parameter></invoke>` +
			`<invoke name="read_file"><parameter name="path">a.ts</parameter></invoke>`
		const events = scanChunked(fixture, [40, 40, 40])
		expect(calls(events)).toStrictEqual([
			{ kind: "call", name: "write_to_file", arguments: '{"content":"line1\\n~~~\\nline2"}' },
			{ kind: "call", name: "read_file", arguments: '{"path":"a.ts"}' },
		])
		expect(text(events)).toBe("")
	})

	it("keeps an invoke in a tilde fence opener's info string as text", () => {
		// CommonMark: text behind an opening tilde fence is the info
		// string. feedContext records the fence only when the line
		// completes, and no backtick run exists to trip the span check,
		// so the opener verdict must read the current line's fence
		// prefix or the info-string markup recovers as a call.
		const fixture = `~~~ <invoke name="get_weather"></invoke>\n~~~\nafter`
		const events = scanChunked(fixture, [30, 10, 6])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it("recovers a call after the tilde fence that quoted markup in its info string closes", () => {
		// The info-string check must not over-quote: once the fence
		// closes, the call below is live again.
		const fixture = `~~~ <invoke name="get_weather"></invoke>\n~~~\n${bareWeatherCall("Rome")}`
		const events = scanChunked(fixture, [30, 10, 20])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe(`~~~ <invoke name="get_weather"></invoke>\n~~~\n`)
	})

	it("recovers a call on a line that mentions tildes mid-line", () => {
		// CommonMark opens a fence only on a line whose content starts
		// with the marker run: mid-line tildes are prose, and the call
		// after them stays live.
		const fixture = `see ~~~ below ${bareWeatherCall("Rome")}`
		const events = scanChunked(fixture, [14, 20, 10])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe("see ~~~ below ")
	})

	it("keeps an inline-code-span-quoted invoke block as text", () => {
		const quoted = bareWeatherCall("Rome")
		const events = scanChunked(`use \`markup ${quoted}\` verbatim`, [6, 40, 10])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(`use \`markup ${quoted}\` verbatim`)
	})

	it("does not treat a backtick fence line with a backtick info string as a fence opener", () => {
		// CommonMark: a backtick fence's info string must contain no
		// backtick, so ```lang`value is prose and its runs are span
		// markers. The offered call after that line must still recover:
		// an empty-call assertion would pass even if the scanner wrongly
		// opened a fence at the invalid line and quoted the call.
		const fixture = "```lang`value\nplain\n" + bareWeatherCall("Rome") + "\n```\nrest"
		const events = scanChunked(fixture, [8, 10, 10])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe("```lang`value\nplain\n\n```\nrest")
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

	it("keeps a wrapped unknown tool as text", () => {
		// The wrapper skeleton around an unknown name must stay text,
		// wrapper tags included: stepWrapper rejects the opener when
		// the name is not offered.
		const fixture = `<function_calls><invoke name="unknown_tool"><parameter name="a">b</parameter></invoke></function_calls>`
		const events = scanChunked(fixture, [17, 30, 40])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it("keeps an inline-code-wrapped function_calls block as text", () => {
		// A live code span quotes the whole wrapped skeleton.
		const fixture =
			'use `<function_calls><invoke name="get_weather"><parameter name="location">Berlin</parameter></invoke></function_calls>` verbatim'
		const events = scanChunked(fixture, [6, 40, 40])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
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

	it("keeps the last value of a repeated parameter", () => {
		// Pin the duplicate-key rule: a later <parameter> with the same
		// name overwrites the earlier one, so arguments carry the last
		// value. A change in duplicate handling fails this exact-string
		// assertion.
		const fixture =
			`<invoke name="get_weather"><parameter name="location">Berlin</parameter>` +
			`<parameter name="location">Rome</parameter></invoke>`
		const events = scanChunked(fixture, [12, 40, 30])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe("")
	})

	it("stores a __proto__ parameter name as an own property", () => {
		// An ordinary object inherits the __proto__ setter: a plain
		// assignment swallows the value and the arguments lose the key.
		// The null-prototype dictionary keeps it as an own property in
		// written order, and the duplicate-parameter rule is unchanged.
		const fixture =
			`<invoke name="get_weather"><parameter name="__proto__">Rome</parameter>` +
			`<parameter name="unit">c</parameter></invoke>`
		const events = scanChunked(fixture, [12, 30, 20])
		expect(calls(events)).toStrictEqual([
			{ kind: "call", name: "get_weather", arguments: '{"__proto__":"Rome","unit":"c"}' },
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

	it.each([
		["newline", "bare", `<invoke\nname="get_weather"><parameter name="location">Rome</parameter></invoke>`],
		["tab", "bare", `<invoke\tname="get_weather"><parameter name="location">Rome</parameter></invoke>`],
		[
			"newline",
			"wrapped",
			`<function_calls>\n<invoke\nname="get_weather"><parameter name="location">Rome</parameter></invoke></function_calls>`,
		],
		[
			"tab",
			"wrapped",
			`<function_calls>\n<invoke\tname="get_weather"><parameter name="location">Rome</parameter></invoke></function_calls>`,
		],
	])("recovers a %s call whose opener uses a %s separator after invoke", (_sep, _shape, fixture) => {
		// XML whitespace after `invoke` is legal opener syntax; the marker
		// probe must hand such openers to the parser, not emit them as text.
		const events = scanChunked(fixture, [16, 30, 20])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe("")
	})

	it("recovers both calls of adjacent bare blocks split by a dotted capital I", () => {
		// U+0130 lowercases to two code points, so a lowercased copy of
		// the hold is longer than the hold itself: the close offset must
		// come from the original string, or drop() eats the next call's
		// `<` and recovery starts depending on chunk boundaries.
		const fixture =
			`<invoke name="get_weather"><parameter name="city">\u0130stanbul</parameter></invoke>` +
			`<invoke name="get_weather"><parameter name="city">Rome</parameter></invoke>`
		const expected = [
			{ kind: "call", name: "get_weather", arguments: '{"city":"\u0130stanbul"}' },
			{ kind: "call", name: "get_weather", arguments: '{"city":"Rome"}' },
		]
		expect(calls(scanChunked(fixture, [fixture.length]))).toStrictEqual(expected)
		expect(calls(scanChunked(fixture, [37, 44, 38]))).toStrictEqual(expected)
		expect(calls(scanChunked(fixture, [79, fixture.length - 79]))).toStrictEqual(expected)
		// The skeleton must never leak to the text sink, in any split.
		expect(text(scanChunked(fixture, [fixture.length]))).toBe("")
		expect(text(scanChunked(fixture, [37, 44, 38]))).toBe("")
		expect(text(scanChunked(fixture, [79, fixture.length - 79]))).toBe("")
	})

	it("keeps a fence inside a block quote as text", () => {
		// CommonMark opens and closes fenced code blocks inside block
		// quotes: the quoted example must stay text, never recover.
		const fixture = `> ~~~\n> ${bareWeatherCall("Rome")}\n> ~~~\nafter`
		const events = scanChunked(fixture, [6, 40, 20])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it("keeps an invoke inside a nested block-quote fence as text", () => {
		// CommonMark nests block quotes: a depth-2 fence line carries the
		// same two quote levels, so the example stays text and recovers
		// nothing.
		const fixture = `> > ~~~\n> > ${bareWeatherCall("Rome")}\n> > ~~~\nafter`
		const events = scanChunked(fixture, [8, 40, 10])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it.each([
		[
			"four columns in ends the quoted fence",
			`> > ~~~\n>\t  > example\n${bareWeatherCall("Rome")}`,
			[{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }],
			`> > ~~~\n>\t  > example\n`,
		],
		[
			"three columns in keeps the quoted fence",
			`> > ~~~\n>\t > example\n> > ${bareWeatherCall("Rome")}\n> > ~~~`,
			[],
			`> > ~~~\n>\t > example\n> > ${bareWeatherCall("Rome")}\n> > ~~~`,
		],
	])("counts residual tab columns at the next quote level: %s", (_label, fixture, expectedCalls, expectedText) => {
		// CommonMark limits a quote marker to three columns inside the
		// enclosing content region. A tab partly consumed as the outer
		// marker's padding leaves residual columns there: with two more
		// spaces the second marker sits four columns in, so the inner
		// quote ends, its fence ends, and the call below is live again;
		// with one space it sits three in and stays quoted.
		const events = scanChunked(fixture, [8, 40, 10])
		expect(calls(events)).toStrictEqual(expectedCalls)
		expect(text(events)).toBe(expectedText)
	})

	it("keeps a quote-prefixed line inside a top-level fence as fence content", () => {
		// CommonMark: fenced content is literal text. A top-level
		// fence does not close on `> ~~~`, so the example stays text.
		const fixture = `~~~\n> ~~~\n${bareWeatherCall("Rome")}\n~~~`
		const events = scanChunked(fixture, [4, 30, 10])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it("closes a quoted fence when its block quote ends and recovers a later call", () => {
		// CommonMark ends an unclosed fenced block when its enclosing
		// block quote ends: the call outside the quote is live again.
		const fixture = `> ~~~\n> example\n\n${bareWeatherCall("Rome")}`
		const events = scanChunked(fixture, [6, 30, 30])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe(`> ~~~\n> example\n\n`)
	})

	it("keeps a fence inside a list item as text", () => {
		// CommonMark opens and closes fenced code blocks inside list
		// items: the example stays text, never recovers.
		const fixture = `- ~~~\n  ${bareWeatherCall("Rome")}\n  ~~~\nafter`
		const events = scanChunked(fixture, [5, 30, 10])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it("keeps a tab-indented fence inside a list item as text", () => {
		// CommonMark expands a tab to the next four-column tab stop, so a
		// tab-indented line still satisfies the list item's content
		// indent: the fence stays open and the example stays text, never
		// recovers.
		const fixture = `- ~~~\n	code\n  <invoke name="get_weather"></invoke>\n  ~~~\nafter`
		const events = scanChunked(fixture, [5, 30, 10])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it.each([
		["four-column", `	  ~~~`],
		["five-column", `	   ~~~`],
	])("keeps a %s tab-space closer line inside a list item as fence content", (_label, closerLine) => {
		// CommonMark measures a closing fence in columns inside the
		// container: a tab partly consumed by the 2-column item indent
		// keeps its residual columns, so `	  ~~~` sits 4 columns deep
		// and `	   ~~~` sits 5 - both are fence content, never a
		// closer. The fenced example stays text and recovers nothing.
		const fixture = `- ~~~\n${closerLine}\n  <invoke name="get_weather"></invoke>\n  ~~~`
		const events = scanChunked(fixture, [5, 30, 10])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it("still closes a list-item fence on a closer line three columns inside", () => {
		// `	 ~~~` sits three columns inside the item (tab stop 4 minus
		// the 2-column indent, plus one space): at most three columns
		// close, so the fence ends and a later call is live again.
		const fixture = `- ~~~\n	 ~~~\n\n${bareWeatherCall("Rome")}`
		const events = scanChunked(fixture, [5, 30, 30])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe(`- ~~~\n	 ~~~\n\n`)
	})

	it("closes a quoted fence on a tab closer within three columns", () => {
		// The quote path measures the same columns: `> 	 ~~~` sits
		// three columns inside the quote, so the fence closes there and
		// the next quoted fence line opens a NEW fence that keeps the
		// following call quoted.
		const fixture = `> ~~~\n> 	 ~~~\n> ~~~\n> ${bareWeatherCall("Rome")}\n> ~~~`
		const events = scanChunked(fixture, [6, 30, 30])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it("closes a quoted fence on a tab-padding closer line and requotes the example", () => {
		// CommonMark consumes one column of a tab as the quote marker's
		// optional padding, so `>\t ~~~` closes the fence three columns
		// deep inside the quote. Measuring the closer from the prefix
		// byte length leaves the fence open across the next `> ~~~`,
		// ends the block early, and recovers the quoted call below.
		const fixture = `> ~~~\n>\t ~~~\n> ~~~\n> ${bareWeatherCall("Rome")}\n> ~~~`
		const events = scanChunked(fixture, [6, 30, 30])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it("keeps a closer line whose suffix has a non-breaking space as fence content", () => {
		// CommonMark allows only spaces and tabs after a closing fence
		// run. A U+00A0 behind the run is content, so the fence stays
		// open: the call below stays quoted text and recovers nothing.
		const fixture = `>\t~~~\n> ~~~\u00a0\n> ${bareWeatherCall("Rome")}\n> ~~~`
		const events = scanChunked(fixture, [6, 30, 30])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it.each([
		["trailing spaces", "~~~ \r\n"],
		["a trailing tab", "~~~\t\r\n"],
		["a bare CRLF line end", "~~~\r\n"],
	])("closes a quoted fence on a CRLF closer with %s behind the run", (_label, closerBody) => {
		// feedContext splits lines on LF and leaves the CR of a CRLF
		// pair on the line, so a closer's suffix can end in CR. Spaces
		// and a CR stay allowed after the run. The call sits on the next
		// quote-prefixed line, so an accepted closer is the only path to
		// recovery: a rejected closer keeps the fence open and the call
		// stays quoted fence text.
		const fixture = `> ~~~\r\n> example\r\n> ${closerBody}> ${bareWeatherCall("Rome")}\r\n`
		const events = scanChunked(fixture, [6, 30, 30])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe(`> ~~~\r\n> example\r\n> ${closerBody}> \r\n`)
	})

	it("opens a quoted fence whose opener pads the marker with a tab", () => {
		// CommonMark consumes one column of a tab as the quote marker's
		// optional padding: the fence after `>\t` sits three residual
		// columns inside the quote, so it opens and the example below
		// stays quoted text.
		const fixture = `>\t~~~\n> ${bareWeatherCall("Rome")}\n> ~~~`
		const events = scanChunked(fixture, [3, 30, 10])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it("re-opens a top-level fence on the line that ends the quoted fence", () => {
		// CommonMark ends an unclosed fenced block when its container
		// ends, and the same line can open a new fence at the top
		// level: the example after the transition stays inside the new
		// fence as literal content.
		const fixture = `> ~~~\n~~~\n${bareWeatherCall("Rome")}\n~~~`
		const events = scanChunked(fixture, [6, 30, 10])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it("recovers a live call after a closed tilde fence", () => {
		// A closed fence stops quoting: the call after it is live.
		const fixture = `~~~\ncode\n~~~\n\n${bareWeatherCall("Rome")}`
		const events = scanChunked(fixture, [4, 30, 30])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe("~~~\ncode\n~~~\n\n")
	})

	it("recovers a live call after a closed inline code span on the same line", () => {
		const fixture = "`x` " + bareWeatherCall("Rome")
		const events = scanChunked(fixture, [2, 30, 10])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe("`x` ")
	})

	it("keeps an invoke inside a double-backtick span with a single backtick as text", () => {
		// CommonMark: a `` span closes only on a run of the same width,
		// so the single backtick inside cannot close it and both invokes
		// stay quoted. A width-ignoring check would end the span at the
		// single backtick and recover the second invoke.
		const quoted = bareWeatherCall("Rome")
		const fixture = `\`\` ${quoted} \`${quoted}\`\` tail`
		const events = scanChunked(fixture, [4, 30, 10])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
	})

	it("recovers a call that follows a closed double-backtick span", () => {
		// The span's closing `` run ends the quote: the call after it is
		// live again.
		const fixture = `\`\` code \`\` <invoke name="get_weather"></invoke>`
		const events = scanChunked(fixture, [4, 20, 10])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: "{}" }])
		expect(text(events)).toBe("`` code `` ")
	})

	it("recovers a single-quoted invoke name", () => {
		const fixture = `<invoke name='get_weather'><parameter name="location">Rome</parameter></invoke>`
		const events = scanChunked(fixture, [7, 30, 20])
		expect(calls(events)).toStrictEqual([{ kind: "call", name: "get_weather", arguments: '{"location":"Rome"}' }])
		expect(text(events)).toBe("")
	})

	it.each([
		["unquoted attribute", `<invoke name=get_weather><parameter name="a">b</parameter></invoke>`],
		["empty quoted name", `<invoke name=""><parameter name="a">b</parameter></invoke>`],
		["stray invoke closer", "text </invoke> more"],
		["nameless invoke opener", "text <invoke> more"],
	])("keeps a malformed opener (%s) as text", (_label, fixture) => {
		const events = scanChunked(fixture, [6, 30, 10])
		expect(calls(events)).toStrictEqual([])
		expect(text(events)).toBe(fixture)
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
