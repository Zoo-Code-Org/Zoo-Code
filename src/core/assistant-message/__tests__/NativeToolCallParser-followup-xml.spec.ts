import { NativeToolCallParser } from "../NativeToolCallParser"

describe("NativeToolCallParser - ask_followup_question legacy XML recovery", () => {
	// The follow_up payload from issue 1034: the model emits the old XML
	// tool-call form inside the question string and sends no follow_up field.
	const issueQuestion =
		"Should we use the config file or environment variables?</question>\n" +
		'<follow_up>[{"mode": null, "text": "Alternative 1."}, {"mode": null, "text": "Alternative 2."}]</follow_up>\n' +
		"</invoke>"

	const makeToolCall = (args: Record<string, unknown>) => ({
		id: "toolu_123",
		name: "ask_followup_question" as const,
		arguments: JSON.stringify(args),
	})

	const nativeArgsOf = (args: Record<string, unknown>): { question: unknown; follow_up: unknown } | null => {
		const result = NativeToolCallParser.parseToolCall(makeToolCall(args))
		if (result?.type !== "tool_use") {
			return null
		}
		return result.nativeArgs as { question: unknown; follow_up: unknown }
	}

	it("recovers follow_up from XML markup when the follow_up field is absent (issue 1034)", () => {
		const nativeArgs = nativeArgsOf({ question: issueQuestion })

		expect(nativeArgs).not.toBeNull()
		expect(Array.isArray(nativeArgs?.follow_up)).toBe(true)
		expect(nativeArgs?.follow_up).toEqual([
			{ mode: null, text: "Alternative 1." },
			{ mode: null, text: "Alternative 2." },
		])
	})

	it("recovers follow_up from XML markup when the follow_up field is null", () => {
		const nativeArgs = nativeArgsOf({ question: issueQuestion, follow_up: null })

		expect(nativeArgs).not.toBeNull()
		expect(Array.isArray(nativeArgs?.follow_up)).toBe(true)
		expect(nativeArgs?.follow_up).toEqual([
			{ mode: null, text: "Alternative 1." },
			{ mode: null, text: "Alternative 2." },
		])
	})

	it('recovers follow_up from the <parameter name="follow_up"> form', () => {
		const question =
			'Which database do you prefer?\n<parameter name="follow_up">[{"text": "Postgres"}, {"text": "SQLite"}]</parameter>'
		const nativeArgs = nativeArgsOf({ question })

		expect(nativeArgs).not.toBeNull()
		expect(Array.isArray(nativeArgs?.follow_up)).toBe(true)
		expect(nativeArgs?.follow_up).toEqual([{ text: "Postgres" }, { text: "SQLite" }])
	})

	it("keeps an explicit follow_up array and does not touch a plain question", () => {
		const nativeArgs = nativeArgsOf({
			question: "Which database do you prefer?",
			follow_up: [{ text: "Postgres" }],
		})

		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toEqual([{ text: "Postgres" }])
		expect(nativeArgs?.question).toBe("Which database do you prefer?")
	})

	it("shows a question with no XML markup after recovery", () => {
		const nativeArgs = nativeArgsOf({ question: issueQuestion })

		expect(nativeArgs?.question).toBe("Should we use the config file or environment variables?")
		expect(String(nativeArgs?.question)).not.toMatch(/<[/]?(question|follow_up|invoke|parameter)/)
	})

	it("rejects the tool call when the XML payload does not parse", () => {
		const question = "Pick one:</question>\n<follow_up>not-json</follow_up>\n</invoke>"
		const result = NativeToolCallParser.parseToolCall(makeToolCall({ question }))

		// An unparseable payload cannot be recovered. Keep the old reject.
		expect(result).toBeNull()
	})

	it("rejects the tool call when the XML payload is not an array", () => {
		const question = 'Pick one:</question>\n<follow_up>{"text": "A"}</follow_up>\n</invoke>'
		const result = NativeToolCallParser.parseToolCall(makeToolCall({ question }))

		expect(result).toBeNull()
	})

	// Property test from the spec invariant NoMissingFollowUpWhenRecoverable:
	// every recoverable payload (XML block with a parseable JSON array) reaches
	// the tool with a present follow_up, and the shown question holds no XML.
	it("property: every recoverable payload reaches the tool clean", () => {
		const payloads = [
			'[{ "text": "A" }]',
			'[{"mode": null, "text": "Alternative 1."}]',
			'[{"text": "A"}, {"text": "B"}, {"text": "C"}]',
		]
		const wrappers = [
			(p: string) => `Q?</question>\n<follow_up>${p}</follow_up>\n</invoke>`,
			(p: string) => `Q?\n<parameter name="follow_up">${p}</parameter>`,
		]

		for (const payload of payloads) {
			for (const wrap of wrappers) {
				for (const followUp of [undefined, null]) {
					const args: Record<string, unknown> = { question: wrap(payload) }
					if (followUp !== undefined) {
						args.follow_up = followUp
					}

					const nativeArgs = nativeArgsOf(args)

					expect(nativeArgs).not.toBeNull()
					expect(Array.isArray(nativeArgs?.follow_up)).toBe(true)
					expect(String(nativeArgs?.question)).not.toMatch(/<[/]?(question|follow_up|invoke|parameter)/)
				}
			}
		}
	})
})
