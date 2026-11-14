import { parseFrontmatter } from "../frontmatter"

describe("parseFrontmatter", () => {
	it.each(["", "yaml", "yml", "json"])("accepts data language %s", (language) => {
		const metadata = language === "json" ? '{"name":"example"}' : "name: example"
		expect(parseFrontmatter(`---${language}\n${metadata}\n---\nBody`)).toMatchObject({
			data: { name: "example" },
			content: "Body",
		})
	})

	it.each(["js", "javascript", "JavaScript", "coffee", "toml", "__proto__"])(
		"rejects unsupported language %s before execution",
		(language) => {
			const probe = vi.fn()
			vi.stubGlobal("frontmatterProbe", probe)
			try {
				for (const prefix of ["", "\uFEFF"]) {
					expect(() =>
						parseFrontmatter(`${prefix}---${language}\r\n(globalThis.frontmatterProbe(), {})\r\n---`),
					).toThrow("Unsupported frontmatter language")
				}
				expect(probe).not.toHaveBeenCalled()
			} finally {
				vi.unstubAllGlobals()
			}
		},
	)

	it("preserves documents without frontmatter", () => {
		expect(parseFrontmatter("# Instructions").content).toBe("# Instructions")
	})

	it("rejects executable YAML tags", () => {
		expect(() => parseFrontmatter('---\nvalue: !!js/function "function () {}"\n---')).toThrow()
	})
})
