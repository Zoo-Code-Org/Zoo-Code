import {
	parseEnvironmentSections,
	diffEnvironmentDetails,
	assembleEnvironmentDetails,
	ALWAYS_INCLUDE_SECTIONS,
} from "../environmentDiff"

// ---------------------------------------------------------------------------
// parseEnvironmentSections
// ---------------------------------------------------------------------------

describe("parseEnvironmentSections", () => {
	it("returns an empty map for an empty string", () => {
		const result = parseEnvironmentSections("")
		expect(result.size).toBe(0)
	})

	it("parses a single section with content", () => {
		const input = `# Current Time\n2024-01-01T00:00:00Z`
		const result = parseEnvironmentSections(input)
		expect(result.size).toBe(1)
		expect(result.get("Current Time")).toBe("2024-01-01T00:00:00Z")
	})

	it("parses multiple top-level sections", () => {
		const input = `# VSCode Visible Files\nfoo.ts\n\n# VSCode Open Tabs\nbar.ts\n\n# Current Time\nnow`
		const result = parseEnvironmentSections(input)
		expect(result.size).toBe(3)
		expect(result.get("VSCode Visible Files")).toBe("foo.ts")
		expect(result.get("VSCode Open Tabs")).toBe("bar.ts")
		expect(result.get("Current Time")).toBe("now")
	})

	it("groups sub-headers (## ...) under their parent section", () => {
		const input = `# Actively Running Terminals\n## Terminal 1 (Active)\n### Working Directory: \`/tmp\`\n### New Output\nhello`
		const result = parseEnvironmentSections(input)
		expect(result.size).toBe(1)
		const content = result.get("Actively Running Terminals")
		expect(content).toContain("## Terminal 1 (Active)")
		expect(content).toContain("### Working Directory")
		expect(content).toContain("hello")
	})

	it("handles a header with no body content", () => {
		const input = `# Current Mode`
		const result = parseEnvironmentSections(input)
		expect(result.size).toBe(1)
		expect(result.get("Current Mode")).toBe("")
	})

	it("strips wrapping <environment_details> tags before parsing", () => {
		const input = `<environment_details>\n# Current Cost\n$0.00\n</environment_details>`
		const result = parseEnvironmentSections(input)
		expect(result.size).toBe(1)
		expect(result.get("Current Cost")).toBe("$0.00")
	})
})

// ---------------------------------------------------------------------------
// diffEnvironmentDetails
// ---------------------------------------------------------------------------

describe("diffEnvironmentDetails — first call (no previous)", () => {
	it("returns all sections when previous is null", () => {
		const current = new Map([
			["VSCode Visible Files", "foo.ts"],
			["Current Time", "now"],
			["Current Cost", "$0.00"],
		])
		const { sections, wasFiltered } = diffEnvironmentDetails(null, current)
		expect(wasFiltered).toBe(false)
		expect(sections.size).toBe(current.size)
		for (const [k, v] of current) {
			expect(sections.get(k)).toBe(v)
		}
	})
})

describe("diffEnvironmentDetails — second call with identical content", () => {
	it("returns only ALWAYS_INCLUDE sections when nothing changed", () => {
		const content = new Map([
			["VSCode Visible Files", "foo.ts"],
			["VSCode Open Tabs", "bar.ts"],
			["Current Time", "t1"],
			["Current Cost", "$0.10"],
			["Current Mode", "code"],
		])

		const { sections, wasFiltered } = diffEnvironmentDetails(new Map(content), content)

		expect(wasFiltered).toBe(true)
		// Changed sections should be absent.
		expect(sections.has("VSCode Visible Files")).toBe(false)
		expect(sections.has("VSCode Open Tabs")).toBe(false)
		// ALWAYS_INCLUDE sections should be present.
		expect(sections.has("Current Time")).toBe(true)
		expect(sections.has("Current Cost")).toBe(true)
		expect(sections.has("Current Mode")).toBe(true)
	})
})

describe("diffEnvironmentDetails — second call with one changed section", () => {
	it("includes the changed section plus ALWAYS_INCLUDE sections", () => {
		const previous = new Map([
			["VSCode Visible Files", "foo.ts"],
			["Current Time", "t1"],
			["Current Cost", "$0.00"],
		])
		const current = new Map([
			["VSCode Visible Files", "foo.ts bar.ts"], // changed
			["Current Time", "t2"], // ALWAYS_INCLUDE (also changed)
			["Current Cost", "$0.05"], // ALWAYS_INCLUDE (also changed)
		])

		const { sections, wasFiltered } = diffEnvironmentDetails(previous, current)

		expect(wasFiltered).toBe(false) // all sections are included
		expect(sections.get("VSCode Visible Files")).toBe("foo.ts bar.ts")
		expect(sections.get("Current Time")).toBe("t2")
		expect(sections.get("Current Cost")).toBe("$0.05")
	})

	it("omits unchanged non-always-include sections and sets wasFiltered", () => {
		const previous = new Map([
			["VSCode Visible Files", "foo.ts"],
			["VSCode Open Tabs", "bar.ts"],
			["Current Time", "t1"],
		])
		const current = new Map([
			["VSCode Visible Files", "foo.ts"], // unchanged, not ALWAYS_INCLUDE
			["VSCode Open Tabs", "baz.ts"], // changed
			["Current Time", "t2"], // ALWAYS_INCLUDE (changed)
		])

		const { sections, wasFiltered } = diffEnvironmentDetails(previous, current)

		expect(wasFiltered).toBe(true)
		expect(sections.has("VSCode Visible Files")).toBe(false)
		expect(sections.get("VSCode Open Tabs")).toBe("baz.ts")
		expect(sections.get("Current Time")).toBe("t2")
	})
})

describe("diffEnvironmentDetails — ALWAYS_INCLUDE_SECTIONS always present", () => {
	it("includes ALWAYS_INCLUDE sections even when their content is unchanged", () => {
		const sharedContent = new Map<string, string>()
		for (const name of ALWAYS_INCLUDE_SECTIONS) {
			sharedContent.set(name, "static-value")
		}

		const { sections, wasFiltered: _ } = diffEnvironmentDetails(new Map(sharedContent), sharedContent)

		for (const name of ALWAYS_INCLUDE_SECTIONS) {
			expect(sections.has(name)).toBe(true)
		}
	})
})

describe("diffEnvironmentDetails — new sections in current that are absent from previous", () => {
	it("includes brand-new sections (they count as changed)", () => {
		const previous = new Map([["Current Time", "t1"]])
		const current = new Map([
			["Current Time", "t1"],
			["Git Status", "M src/foo.ts"], // new section, not in previous
		])

		const { sections, wasFiltered } = diffEnvironmentDetails(previous, current)

		expect(sections.has("Git Status")).toBe(true)
		// Current Time is ALWAYS_INCLUDE and unchanged — still present.
		expect(sections.has("Current Time")).toBe(true)
		expect(wasFiltered).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// assembleEnvironmentDetails
// ---------------------------------------------------------------------------

describe("assembleEnvironmentDetails", () => {
	it("wraps output in <environment_details> tags", () => {
		const sections = new Map([["Current Time", "now"]])
		const result = assembleEnvironmentDetails(sections, false)
		expect(result.startsWith("<environment_details>")).toBe(true)
		expect(result.endsWith("</environment_details>")).toBe(true)
	})

	it("includes the omission preamble when wasFiltered is true", () => {
		const sections = new Map([["Current Time", "now"]])
		const result = assembleEnvironmentDetails(sections, true)
		expect(result).toContain("Unchanged environment sections omitted")
	})

	it("does not include the preamble when wasFiltered is false", () => {
		const sections = new Map([["Current Time", "now"]])
		const result = assembleEnvironmentDetails(sections, false)
		expect(result).not.toContain("Unchanged environment sections omitted")
	})

	it("renders each section with its # header", () => {
		const sections = new Map([
			["Current Time", "now"],
			["Current Cost", "$1.00"],
		])
		const result = assembleEnvironmentDetails(sections, false)
		expect(result).toContain("# Current Time\nnow")
		expect(result).toContain("# Current Cost\n$1.00")
	})

	it("round-trips through parseEnvironmentSections", () => {
		const original = new Map([
			["VSCode Visible Files", "foo.ts\nbar.ts"],
			["Current Time", "now"],
			["Current Mode", "<slug>code</slug>"],
		])
		const assembled = assembleEnvironmentDetails(original, false)
		const reparsed = parseEnvironmentSections(assembled)
		for (const [k, v] of original) {
			expect(reparsed.get(k)).toBe(v)
		}
	})
})
