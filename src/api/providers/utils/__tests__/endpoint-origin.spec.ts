import { getLoggableOrigin } from "../endpoint-origin"

describe("getLoggableOrigin", () => {
	it.each([
		["http://localhost:11434", "http://localhost:11434"],
		["https://example.com/v1/path?key=secret", "https://example.com"],
		["https://user:pass@example.com:8443/x", "https://example.com:8443"],
	])("returns the origin of %s", (input, expected) => {
		expect(getLoggableOrigin(input)).toBe(expected)
	})

	it.each(["localhost:11434", "127.0.0.1:11434", "not a url", "", "ftp://user:pass@host/"])(
		"returns the fixed phrase for %j",
		(input) => {
			expect(getLoggableOrigin(input)).toBe("the configured endpoint")
		},
	)
})
