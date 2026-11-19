import { readResponsesReasoningItem } from "../responses-api-reasoning"
import { assertResponsesApiSuccess } from "../responses-api-error"
import { convertToResponsesApiInput } from "../responses-api-input"

const reasoning = {
	type: "reasoning",
	id: "rs1",
	encrypted_content: "opaque",
	summary: [{ type: "summary_text", text: "summary" }],
}

it.each([reasoning, { ...reasoning, summary: undefined }])("accepts valid reasoning items: %j", (item) => {
	expect(readResponsesReasoningItem(item)).toEqual({ ...item, summary: item.summary ?? [] })
})

it.each([
	null,
	"reasoning",
	{},
	{ ...reasoning, id: "" },
	{ ...reasoning, encrypted_content: 1 },
	{ ...reasoning, type: "text" },
	{ ...reasoning, summary: "summary" },
	{ ...reasoning, summary: [null] },
	{ ...reasoning, summary: [{ type: "summary_text", text: 1 }] },
])("rejects invalid reasoning items: %j", (item) => {
	expect(readResponsesReasoningItem(item)).toBeUndefined()
	const message = { role: "assistant" as const, content: "answer", reasoning_details: [item] }
	expect(convertToResponsesApiInput([message])).toEqual([
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
	])
})

it("replays all reasoning details before tool calls in their stored order", () => {
	const second = { ...reasoning, id: "rs2", encrypted_content: "opaque2" }
	const message = {
		role: "assistant" as const,
		content: [{ type: "tool_use" as const, id: "call1", name: "read_file", input: {} }],
		reasoning_details: [reasoning, second],
	}
	expect(convertToResponsesApiInput([message]).slice(0, 2)).toEqual([reasoning, second])
	expect(convertToResponsesApiInput([message])[2]).toMatchObject({ type: "function_call", call_id: "call1" })
})

it.each([undefined, null, {}, { status: "completed" }])("accepts successful or legacy responses: %j", (response) => {
	expect(() => assertResponsesApiSuccess(response)).not.toThrow()
})

it.each(["failed", "incomplete", "cancelled"])("rejects terminal status %s", (status) => {
	expect(() => assertResponsesApiSuccess({ status, error: { message: "failure", code: "backend_error" } })).toThrow(
		"failure",
	)
})

it("preserves terminal failure details", () => {
	try {
		assertResponsesApiSuccess({ status: "failed", error: { message: "failure", code: "backend_error" } })
	} catch (error) {
		expect(error).toMatchObject({
			code: "backend_error",
			errorDetails: { message: "failure", code: "backend_error" },
		})
		return
	}
	throw new Error("Expected terminal failure")
})

it("accepts a standalone encrypted reasoning item from existing history", () => {
	const item = { type: "reasoning" as const, id: "rs1", encrypted_content: "opaque", summary: [] }
	expect(convertToResponsesApiInput([item])).toEqual([item])
})
