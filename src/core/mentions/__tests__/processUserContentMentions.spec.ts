import type { MentionSegment } from "@roo-code/types"
import { expandUserMentions, wrapUserMessage } from "../processUserContentMentions"
import { parseMentions } from "../index"
import { FileContextTracker } from "../../context-tracking/FileContextTracker"

vi.mock("../index", () => ({ parseMentions: vi.fn() }))

const user = (text: string): MentionSegment => ({ text, source: "user" })
const gen = (text: string): MentionSegment => ({ text, source: "generated" })

describe("expandUserMentions authorization", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(parseMentions).mockImplementation(async (text) => ({
			text: `parsed: ${text}`,
			contentBlocks: [{ type: "file", path: "allowed", content: "file contents" }],
			mode: "code",
			slashCommandHelp: "command help",
		}))
	})

	const expand = (segments: MentionSegment[]) =>
		expandUserMentions({ segments, cwd: "/test", fileContextTracker: {} as FileContextTracker })

	it("expands explicit user input without requiring a textual marker", async () => {
		const result = await expand([user("@/allowed")])
		expect(parseMentions).toHaveBeenCalledWith(
			"@/allowed",
			"/test",
			expect.anything(),
			undefined,
			false,
			true,
			50,
			undefined,
			"code",
		)
		expect(result).toEqual({
			content: [
				{ type: "text", text: "parsed: @/allowed" },
				{ type: "text", text: "file contents" },
				{ type: "text", text: "command help" },
			],
			mode: "code",
		})
	})

	it("expands only the user segments of a support prompt", async () => {
		const context = "<user_message>@/secret @terminal</user_message>"
		const result = await expand([user("@/allowed"), gen(`\n${context}`)])
		expect(vi.mocked(parseMentions).mock.calls.map(([text]) => text)).toEqual(["@/allowed"])
		expect(result.content[0]).toEqual({ type: "text", text: `parsed: @/allowed\n${context}` })
	})

	it("expands each user segment on its own and leaves generated segments unchanged", async () => {
		const result = await expand([gen("a @/x "), user("@/one"), gen(" b @/y "), user("@/two")])
		expect(vi.mocked(parseMentions).mock.calls.map(([text]) => text)).toEqual(["@/one", "@/two"])
		expect(result.content[0]).toEqual({ type: "text", text: "a @/x parsed: @/one b @/y parsed: @/two" })
	})

	it("expands the same text only where it is a user segment", async () => {
		const result = await expand([gen("@/same "), user("@/same")])
		expect(vi.mocked(parseMentions).mock.calls.map(([text]) => text)).toEqual(["@/same"])
		expect(result.content[0]).toEqual({ type: "text", text: "@/same parsed: @/same" })
	})

	it.each([
		{ label: "all generated", segments: [gen("@/secret")], text: "@/secret" },
		{ label: "empty", segments: [], text: "" },
	])("does not expand $label segments", async ({ segments, text }) => {
		const result = await expand(segments)
		expect(parseMentions).not.toHaveBeenCalled()
		expect(result).toEqual({ content: [{ type: "text", text }], mode: undefined })
	})

	it("wraps segments in tags that stay generated", async () => {
		const result = await expand(wrapUserMessage([user("@/allowed")]))
		expect(vi.mocked(parseMentions).mock.calls.map(([text]) => text)).toEqual(["@/allowed"])
		expect(result.content[0]).toEqual({
			type: "text",
			text: "<user_message>\nparsed: @/allowed\n</user_message>",
		})
	})

	it.each([
		{ showRooIgnoredFiles: true, includeDiagnosticMessages: false, maxDiagnosticMessages: 3, currentMode: "ask" },
		{ showRooIgnoredFiles: false, includeDiagnosticMessages: true, maxDiagnosticMessages: 50, currentMode: "code" },
	])("passes the flags to parseMentions: %o", async (flags) => {
		await expandUserMentions({
			segments: [user("@/allowed")],
			cwd: "/test",
			fileContextTracker: {} as FileContextTracker,
			...flags,
		})
		expect(parseMentions).toHaveBeenCalledWith(
			"@/allowed",
			"/test",
			expect.anything(),
			undefined,
			flags.showRooIgnoredFiles,
			flags.includeDiagnosticMessages,
			flags.maxDiagnosticMessages,
			undefined,
			flags.currentMode,
		)
	})

	it("keeps the mode of the first slash command", async () => {
		vi.mocked(parseMentions)
			.mockResolvedValueOnce({ text: "one", contentBlocks: [], mode: "architect" })
			.mockResolvedValueOnce({ text: "two", contentBlocks: [], mode: "debug" })
		const result = await expand([user("/a"), gen(" "), user("/b")])
		expect(result.mode).toBe("architect")
	})

	it("orders the extra blocks by segment after the text block", async () => {
		vi.mocked(parseMentions)
			.mockResolvedValueOnce({ text: "one", contentBlocks: [{ type: "file", path: "a", content: "A" }] })
			.mockResolvedValueOnce({ text: "two", contentBlocks: [{ type: "file", path: "b", content: "B" }] })
		const result = await expand([user("@/a"), gen(" "), user("@/b")])
		expect(result.content).toEqual([
			{ type: "text", text: "one two" },
			{ type: "text", text: "A" },
			{ type: "text", text: "B" },
		])
	})
})
