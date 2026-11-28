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

	it("recovers follow_up when a closing tag sits inside a JSON string (follow_up form)", () => {
		// The first closing tag is payload content, not the boundary. The
		// truncated candidate fails to parse, so the recovery must move on
		// to the real closing tag (review thread 4658157957).
		const question = 'Q?<follow_up>[{"text":"Use </follow_up>"}]</follow_up>'
		const nativeArgs = nativeArgsOf({ question })

		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toEqual([{ text: "Use </follow_up>" }])
		expect(nativeArgs?.question).toBe("Q?")
	})

	it("recovers follow_up when a closing tag sits inside a JSON string (parameter form)", () => {
		const question = 'Q?<parameter name="follow_up">[{"text":"Use </parameter>"}]</parameter>'
		const nativeArgs = nativeArgsOf({ question })

		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toEqual([{ text: "Use </parameter>" }])
		expect(nativeArgs?.question).toBe("Q?")
	})

	it("selects the enclosing parameter wrapper before a follow_up tag inside its payload", () => {
		// The first <follow_up> match sits inside the parameter payload's
		// JSON string. The enclosing parameter block opens earlier in the
		// source and must be recovered instead (review thread 4658490177).
		const question = 'Q?<parameter name="follow_up">[{"text":"Use <follow_up>[]</follow_up>"}]</parameter>'
		const nativeArgs = nativeArgsOf({ question })

		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toEqual([{ text: "Use <follow_up>[]</follow_up>" }])
		expect(nativeArgs?.question).toBe("Q?")
	})

	it("selects the enclosing follow_up wrapper before a parameter tag inside its payload", () => {
		// Symmetric case: the parameter-style tag sits inside the follow_up
		// payload's JSON string. The enclosing follow_up block opens first.
		const question = 'Q?<follow_up>[{"text":"Use <parameter name=\\"follow_up\\">[]</parameter>"}]</follow_up>'
		const nativeArgs = nativeArgsOf({ question })

		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toEqual([{ text: 'Use <parameter name="follow_up">[]</parameter>' }])
		expect(nativeArgs?.question).toBe("Q?")
	})

	it("keeps an explicit follow_up array and leaves its question untouched", () => {
		const nativeArgs = nativeArgsOf({
			question: issueQuestion,
			follow_up: [{ text: "Explicit option." }],
		})

		// A present follow_up must win: the XML markup in the question is
		// not recovered and not stripped.
		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toEqual([{ text: "Explicit option." }])
		expect(nativeArgs?.question).toBe(issueQuestion)
	})

	it("keeps an explicit follow_up value of any type and leaves its question untouched", () => {
		const nativeArgs = nativeArgsOf({
			question: issueQuestion,
			follow_up: "not-an-array",
		})

		// Present-but-not-an-array forwards the raw value so the tool can
		// report a precise schema error; recovery must not run.
		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toBe("not-an-array")
		expect(nativeArgs?.question).toBe(issueQuestion)
	})

	it("rejects the tool call when no question and no follow_up are sent", () => {
		const result = NativeToolCallParser.parseToolCall(makeToolCall({}))

		expect(result).toBeNull()
	})

	it("marks a recovered legacy XML tool call with usedLegacyFormat", () => {
		const result = NativeToolCallParser.parseToolCall(makeToolCall({ question: issueQuestion }))

		expect(result?.type).toBe("tool_use")
		if (result?.type === "tool_use") {
			expect(result.usedLegacyFormat).toBe(true)
		}
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

	it("strips open and attribute-carrying legacy tags from the recovered question", () => {
		// The full legacy emit: invoke wrapper plus a sibling question
		// parameter. Everything but the question text must be removed.
		const question =
			'<invoke name="ask_followup_question"><parameter name="question">Config file or environment variables?</parameter>' +
			'<parameter name="follow_up">[{"text": "Option A."}, {"text": "Option B."}]</parameter></invoke>'
		const nativeArgs = nativeArgsOf({ question })

		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toEqual([{ text: "Option A." }, { text: "Option B." }])
		expect(nativeArgs?.question).toBe("Config file or environment variables?")
	})

	it("removes an opening <question> tag from the recovered question", () => {
		const question = '<question>Config or env?</question><follow_up>[{"text": "A"}]</follow_up>'
		const nativeArgs = nativeArgsOf({ question })

		expect(nativeArgs?.question).toBe("Config or env?")
		expect(String(nativeArgs?.question)).not.toMatch(/<[/]?question>/)
	})

	it("accepts extra whitespace after the parameter tag", () => {
		const question = 'Q?\n<parameter  name="follow_up">[{"text": "A"}]</parameter>'
		const nativeArgs = nativeArgsOf({ question })

		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toEqual([{ text: "A" }])
	})

	it("accepts a single-quoted follow_up attribute", () => {
		const question = 'Q?\n<parameter name=\'follow_up\'>[{"text": "A"}]</parameter>'
		const nativeArgs = nativeArgsOf({ question })

		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toEqual([{ text: "A" }])
	})

	it("tolerates non-JSON whitespace padding around the payload", () => {
		// Form feed is whitespace for String.prototype.trim but not for
		// JSON.parse; the payload trim must run before parsing.
		const question = '\f<follow_up>\f[{"text": "A"}]\f</follow_up>\f'
		const nativeArgs = nativeArgsOf({ question })

		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toEqual([{ text: "A" }])
	})

	it("strips double-spaced legacy wrapper tags from the recovered question", () => {
		// The cleanup must also remove wrapper tags whose attribute is
		// separated from the tag name by more than one whitespace.
		const question =
			'<invoke  name="ask_followup_question"><parameter  name="question">Config or env?</parameter>' +
			'<parameter  name="follow_up">[{"text": "A."}]</parameter></invoke>'
		const nativeArgs = nativeArgsOf({ question })

		expect(nativeArgs?.follow_up).toEqual([{ text: "A." }])
		expect(nativeArgs?.question).toBe("Config or env?")
		expect(String(nativeArgs?.question)).not.toMatch(/<[/]?(question|follow_up|invoke|parameter)/)
	})

	it("recovers follow_up when an escaped quote precedes an in-string closing tag", () => {
		// The escaped quotes keep the JSON string open across the closing
		// tag, so only the final closing candidate parses (review thread
		// 4658157957).
		const question = 'Q?<follow_up>[{"text":"Say \\"hi\\" </follow_up>"}]</follow_up>'
		const nativeArgs = nativeArgsOf({ question })

		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toEqual([{ text: 'Say "hi" </follow_up>' }])
		expect(nativeArgs?.question).toBe("Q?")
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

	it("rejects the tool call when no closing candidate parses to an array", () => {
		// Every closing-tag candidate yields a payload that either fails
		// to parse or is not an array. Rejection must be retained.
		const question = 'Q?<follow_up>{"text":"</follow_up>"}</follow_up>'
		const result = NativeToolCallParser.parseToolCall(makeToolCall({ question }))

		expect(result).toBeNull()
	})

	it("rejects the tool call when the follow_up wrapper is never closed", () => {
		const question = "Q?<follow_up>[1,2]x"
		const result = NativeToolCallParser.parseToolCall(makeToolCall({ question }))

		expect(result).toBeNull()
	})

	it("rejects recovery when the enclosing payload is a non-array JSON object containing nested wrapper tags (review 4661230351)", () => {
		const nativeArgs = nativeArgsOf({
			question: 'Q?<parameter name="follow_up">{"text":"Use <follow_up>[]</follow_up>"}</parameter>',
		})

		// The nested <follow_up>[]</follow_up> is string content of the
		// enclosing object payload — not a recoverable wrapper.
		expect(nativeArgs).toBeNull()
	})

	it("recovers a standalone array wrapper that follows a rejected non-array payload (review 4661230351)", () => {
		const nativeArgs = nativeArgsOf({
			question:
				'Q?<parameter name="follow_up">{"text":"nope"}</parameter> then <follow_up>[ { "text": "A" } ]</follow_up>',
		})

		// The standalone array wrapper lives outside the rejected span, so
		// it still recovers.
		expect(nativeArgs).not.toBeNull()
		expect(nativeArgs?.follow_up).toEqual([{ text: "A" }])
	})

	// Property test from the spec invariant NoMissingFollowUpWhenRecoverable:
	// every recoverable payload (XML block with a parseable JSON array) reaches
	// the tool with a present follow_up, and the shown question holds no XML.
	it("property: every recoverable payload reaches the tool clean", () => {
		const payloads = [
			'[ { "text": "A" } ]',
			'[{"mode": null, "text": "Alternative 1."}]',
			'[{ "text": "A </follow_up> B" }]',
			'[{ "text": "A </parameter> B" }]',
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
					// Full-output check: the recovered array equals the payload
					// exactly (review thread 4661230345) — no truncation or [].
					expect(nativeArgs?.follow_up).toEqual(JSON.parse(payload))
					expect(String(nativeArgs?.question)).not.toMatch(/<[/]?(question|follow_up|invoke|parameter)/)
				}
			}
		}
	})
})
