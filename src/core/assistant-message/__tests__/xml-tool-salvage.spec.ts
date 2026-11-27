import { salvageXmlToolCalls } from "../xml-tool-salvage"

describe("salvageXmlToolCalls", () => {
	it("parses a single two-level tool block", () => {
		expect(salvageXmlToolCalls("<read_file><path>src/config.ts</path></read_file>")).toStrictEqual([
			{ name: "read_file", args: { path: "src/config.ts" } },
		])
	})

	it("parses consecutive blocks in order, tolerating surrounding whitespace", () => {
		expect(
			salvageXmlToolCalls(
				"\n  <read_file><path>a.ts</path></read_file>\n<search_files><regex>foo</regex></search_files>  \n",
			),
		).toStrictEqual([
			{ name: "read_file", args: { path: "a.ts" } },
			{ name: "search_files", args: { regex: "foo" } },
		])
	})

	it("accepts a zero-parameter block", () => {
		expect(salvageXmlToolCalls("<list_files></list_files>")).toStrictEqual([{ name: "list_files", args: {} }])
	})

	it("decodes the five predefined XML entities in parameter values", () => {
		const salvaged = salvageXmlToolCalls(
			"<write_to_file><content>a &lt; b &gt; c &amp; d</content></write_to_file>",
		)
		expect(salvaged?.[0]?.args.content).toBe("a < b > c & d")
	})

	it("keeps &amp;lt; as literal &lt; (entity decoding is single-pass)", () => {
		const salvaged = salvageXmlToolCalls("<write_to_file><content>&amp;lt; tag</content></write_to_file>")
		expect(salvaged?.[0]?.args.content).toBe("&lt; tag")
	})

	it("keeps an unknown entity such as &nbsp; as the literal text (review 6081008463)", () => {
		const salvaged = salvageXmlToolCalls("<write_to_file><content>a&nbsp;b</content></write_to_file>")
		expect(salvaged?.[0]?.args.content).toBe("a&nbsp;b")
	})

	it("allows markup-like text inside a parameter value", () => {
		const salvaged = salvageXmlToolCalls("<write_to_file><content><div>x</div></content></write_to_file>")
		expect(salvaged?.[0]?.args.content).toBe("<div>x</div>")
	})

	it("rejects prose around the XML (false-positive guard)", () => {
		expect(salvageXmlToolCalls("Let me check the file: <read_file><path>a.ts</path></read_file>")).toBeNull()
		expect(salvageXmlToolCalls("<read_file><path>a.ts</path></read_file> done.")).toBeNull()
	})

	it("rejects plain prose and empty text", () => {
		expect(salvageXmlToolCalls("Just a normal reply.")).toBeNull()
		expect(salvageXmlToolCalls("   \n  ")).toBeNull()
		expect(salvageXmlToolCalls("")).toBeNull()
	})

	it.each([
		["attributed open tag", '<read_file id="x"><path>a.ts</path></read_file>'],
		["self-closing tag", "<read_file/>"],
		["mismatched close tag", "<read_file><path>a.ts</path></search_files>"],
		["unclosed parameter", "<read_file><path>a.ts</read_file>"],
		["comment wrapper", "<!-- tool --><read_file><path>a.ts</path></read_file>"],
		["MCP underscore name", "<mcp__server__tool><path>a.ts</path></mcp__server__tool>"],
		["MCP dash name", "<mcp--server--tool><path>a.ts</path></mcp--server--tool>"],
		["param with invalid name", "<read_file><1path>a.ts</1path></read_file>"],
	])("rejects %s", (_case, text) => {
		expect(salvageXmlToolCalls(text)).toBeNull()
	})

	it("returns null when a same-name child is itself a nested tool block (review round 2026-11-26)", () => {
		// A same-name child whose payload is a well-formed tool block is a
		// nested invocation, not a parameter. Path-first nesting would
		// otherwise promote the outer call while silently dropping the
		// nested request.
		expect(
			salvageXmlToolCalls("<read_file><path>a.ts</path><read_file><path>b.ts</path></read_file></read_file>"),
		).toBeNull()
		expect(salvageXmlToolCalls("<read_file><read_file><path>a.ts</path></read_file></read_file>")).toBeNull()
	})

	it("accepts a same-name value argument such as skill = name (review round 2026-11-26)", () => {
		// The skill tool takes a skill argument: a same-name child with a
		// plain-text value is an ordinary parameter, not a nested block.
		const salvaged = salvageXmlToolCalls("<skill><skill>name</skill></skill>")
		expect(salvaged?.[0]?.name).toBe("skill")
		expect(salvaged?.[0]?.args.skill).toBe("name")
	})

	it("rejects more blocks than the salvage cap", () => {
		const nine = Array.from({ length: 9 }, (_, i) => `<read_file><path>f${i}.ts</path></read_file>`).join("")
		expect(salvageXmlToolCalls(nine)).toBeNull()

		const eight = Array.from({ length: 8 }, (_, i) => `<read_file><path>f${i}.ts</path></read_file>`).join("")
		expect(salvageXmlToolCalls(eight)).toHaveLength(8)
	})
})
