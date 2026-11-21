import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiMessage } from "../../task-persistence"
import { normalizeToolResultPairing } from "../normalizeToolResultPairing"

type Block = Anthropic.Messages.ContentBlockParam

const use = (id: string): Block => ({ type: "tool_use", id, name: "read_file", input: {} })
const result = (id: string, content = `result ${id}`): Block => ({ type: "tool_result", tool_use_id: id, content })
const interrupted = (id: string): Block => ({
	type: "tool_result",
	tool_use_id: id,
	content: "Tool execution was interrupted before completion.",
	is_error: true,
})
const text = (value: string): Block => ({ type: "text", text: value })
const image: Block = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
const assistant = (...content: Block[]): ApiMessage => ({ role: "assistant", content })
const user = (...content: Block[]): ApiMessage => ({ role: "user", content })

describe("normalizeToolResultPairing", () => {
	it("moves interleaved tool results ahead of other content", () => {
		const input = [
			user(text("go")),
			assistant(text("ok"), use("A"), use("B")),
			user(result("A"), image, result("B")),
		]

		expect(normalizeToolResultPairing(input)[2].content).toEqual([result("A"), result("B"), image])
	})

	it("orders results by tool_use order and drops duplicates", () => {
		const input = [assistant(use("A"), use("B")), user(result("B"), result("A"), result("A", "dup"))]

		expect(normalizeToolResultPairing(input)[1].content).toEqual([result("A"), result("B")])
	})

	it("adds a synthetic error result for an interrupted tool_use", () => {
		const input = [assistant(use("A"), use("B")), user(result("A"), text("next"))]

		expect(normalizeToolResultPairing(input)[1].content).toEqual([result("A"), interrupted("B"), text("next")])
	})

	it("preserves string content in the user turn after a tool_use", () => {
		const out = normalizeToolResultPairing([assistant(use("A")), { role: "user", content: "hi" }])

		expect(out[1].content).toEqual([interrupted("A"), text("hi")])
	})

	it("inserts a user turn when an assistant turn is followed by another assistant turn", () => {
		const out = normalizeToolResultPairing([assistant(use("A")), assistant(text("again"))])

		expect(out.map((m) => m.role)).toEqual(["assistant", "user", "assistant"])
		expect(out[1].content).toMatchObject([{ type: "tool_result", tool_use_id: "A" }])
	})

	it.each([
		{ name: "result for an unknown id", messages: [assistant(use("A")), user(result("A"), result("X"))] },
		{
			name: "result after a text-only assistant turn",
			messages: [assistant(text("hi")), user(result("X"), text("q"))],
		},
	])("drops orphan tool results: $name", ({ messages }) => {
		const ids = normalizeToolResultPairing(messages)
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []))

		expect(ids).not.toContain("X")
	})

	it("removes a user message that only held orphan results", () => {
		expect(normalizeToolResultPairing([assistant(text("hi")), user(result("X"))])).toHaveLength(1)
	})

	it("leaves a trailing assistant tool_use and well-formed history unchanged", () => {
		const wellFormed = [user(text("go")), assistant(use("A")), user(result("A"), text("done")), assistant(use("B"))]

		expect(normalizeToolResultPairing(wellFormed)).toEqual(wellFormed)
	})

	it("does not mutate its input", () => {
		const input = [assistant(use("A")), user(image, result("A"))]
		const snapshot = structuredClone(input)

		normalizeToolResultPairing(input)

		expect(input).toEqual(snapshot)
	})
})
