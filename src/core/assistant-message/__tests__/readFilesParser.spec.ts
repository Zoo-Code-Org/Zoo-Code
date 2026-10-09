import { NativeToolCallParser } from "../NativeToolCallParser"
import { MAX_READ_FILES, READ_FILES_TOOL_NAME } from "@roo-code/types"

const parse = (args: unknown) =>
	NativeToolCallParser.parseToolCall({ id: "batch", name: READ_FILES_TOOL_NAME, arguments: JSON.stringify(args) })

describe(`native ${READ_FILES_TOOL_NAME} parsing`, () => {
	it("accepts modern entries and normalizes strict-provider nulls", () => {
		const parsed = parse({
			entries: [
				{ path: "a", mode: null, offset: null, limit: null, indentation: null },
				{
					path: "b",
					mode: "indentation",
					indentation: {
						anchor_line: 5,
						max_levels: null,
						include_header: false,
						include_siblings: null,
						max_lines: null,
					},
				},
			],
		})
		expect(parsed).toMatchObject({
			name: READ_FILES_TOOL_NAME,
			nativeArgs: {
				entries: [
					{ path: "a", mode: undefined, offset: undefined, limit: undefined, indentation: undefined },
					{ path: "b", indentation: { anchor_line: 5, include_header: false } },
				],
			},
		})
	})
	it.each([
		{ entries: [] },
		{ entries: Array.from({ length: MAX_READ_FILES + 1 }, () => ({ path: "a" })) },
		{ entries: [{ path: "" }] },
		{ entries: [{ path: "a", mode: "legacy" }] },
		{ entries: [{ path: "a", offset: 0 }] },
		{ entries: [{ path: "a", limit: 1.5 }] },
		{ entries: [{ path: "a", indentation: { anchor_line: -1 } }] },
		{ entries: [{ path: "a", lineRanges: [{ start: 1, end: 2 }] }] },
		{ files: [{ path: "a" }] },
		{ entries: '[{"path":"a"}]' },
	])("rejects invalid or legacy batch arguments: %j", (args) => {
		expect(parse(args)).toBeNull()
	})
	it("streams one batch without marking it legacy and validates the final call", () => {
		const scope = NativeToolCallParser.createScope()
		NativeToolCallParser.startStreamingToolCall("batch", READ_FILES_TOOL_NAME, scope)
		const partial = NativeToolCallParser.processStreamingChunk("batch", '{"entries":[{"path":"a"},', scope)
		expect(partial).toMatchObject({ name: READ_FILES_TOOL_NAME, partial: true })
		NativeToolCallParser.processStreamingChunk("batch", '{"path":"b","offset":2}]}', scope)
		expect(NativeToolCallParser.finalizeStreamingToolCall("batch", scope)).toMatchObject({
			name: READ_FILES_TOOL_NAME,
			nativeArgs: { entries: [{ path: "a" }, { path: "b", offset: 2 }] },
		})
	})
})
