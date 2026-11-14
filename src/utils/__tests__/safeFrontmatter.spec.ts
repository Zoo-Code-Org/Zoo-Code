import { parseFrontmatter } from "../safeFrontmatter"

describe("parseFrontmatter", () => {
	it.each(["", "yaml", "yml", "json"])("accepts data-only %s metadata", (language) => {
		const metadata = language === "json" ? '{"name":"example"}' : "name: example"
		expect(parseFrontmatter(`---${language}\n${metadata}\n---\nBody`)).toMatchObject({
			data: { name: "example" },
			content: "Body",
		})
	})

	it.each(["javascript", "js", "JavaScript", "JS", " javascript ", "toml"])(
		"rejects %s before executing metadata, including with a BOM",
		(language) => {
			for (const prefix of ["", "\uFEFF"]) {
				const executed = vi.fn()
				vi.stubGlobal("frontmatterExecuted", executed)
				try {
					expect(() =>
						parseFrontmatter(
							`${prefix}---${language}\r\n(globalThis.frontmatterExecuted(), {})\r\n---\r\nBody`,
						),
					).toThrow("Unsupported frontmatter language")
					expect(executed).not.toHaveBeenCalled()
				} finally {
					vi.unstubAllGlobals()
				}
			}
		},
	)

	it("does not strip a second BOM and expose an unchecked selector", () => {
		const executed = vi.fn()
		vi.stubGlobal("frontmatterExecuted", executed)
		try {
			parseFrontmatter("\uFEFF\uFEFF---js\n(globalThis.frontmatterExecuted(), {})\n---\nBody")
			expect(executed).not.toHaveBeenCalled()
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("preserves Markdown without metadata", () => {
		expect(parseFrontmatter("# Heading\nBody").content).toBe("# Heading\nBody")
	})
})
