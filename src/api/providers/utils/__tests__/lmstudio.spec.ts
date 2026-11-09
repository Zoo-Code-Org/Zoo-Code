import { DEFAULT_LM_STUDIO_BASE_URL, normalizeLMStudioBaseUrl } from "../lmstudio"

describe("normalizeLMStudioBaseUrl", () => {
	it.each([undefined, ""])("defaults an unset URL %j", (input) => {
		expect(normalizeLMStudioBaseUrl(input)).toBe(DEFAULT_LM_STUDIO_BASE_URL)
	})

	it.each([
		["http://localhost:1234", "http://localhost:1234"],
		["http://localhost:1234/", "http://localhost:1234"],
		["http://localhost:1234///", "http://localhost:1234"],
		["https://example.com/a//b///", "https://example.com/a//b"],
		["///", ""],
	])("trims only trailing slashes from %j", (input, expected) => {
		expect(normalizeLMStudioBaseUrl(input)).toBe(expected)
	})

	it.each(["", "suffix"])("handles a long slash sequence followed by %j", (suffix) => {
		const prefix = "http://localhost:1234"
		const slashes = "/".repeat(100_000)
		expect(normalizeLMStudioBaseUrl(prefix + slashes + suffix)).toBe(suffix ? prefix + slashes + suffix : prefix)
	})
})
