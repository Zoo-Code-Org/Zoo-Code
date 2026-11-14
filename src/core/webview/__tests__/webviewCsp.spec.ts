import { describe, expect, it } from "vitest"

import { escapeCspAttribute, getOpenRouterCspOrigin } from "../webviewCsp"

describe("getOpenRouterCspOrigin", () => {
	it.each([
		[undefined, "https://openrouter.ai"],
		["https://openrouter.ai/api/v1", "https://openrouter.ai"],
		// Credentials, paths, queries and fragments are stripped, not echoed.
		["https://user:password@EXAMPLE.com:8443/api/v1?key=secret#fragment", "https://example.com:8443"],
		// Local proxy hosts, IPv4 and bracketed IPv6 stay allowed.
		["http://localhost:3000/api/v1", "http://localhost:3000"],
		["http://127.0.0.1:3000/api", "http://127.0.0.1:3000"],
		["http://[::1]:3000/api", "http://[::1]:3000"],
		["http://my_proxy:8080", "http://my_proxy:8080"],
		// CSP delimiters and markup in the path or host fall back to the default.
		['https://example.com/path;script-src?x="><script>attack()</script>', "https://example.com"],
		["https://example.com;script-src", "https://openrouter.ai"],
		[`https://example.com; script-src-elem 'unsafe-inline'"><script>attack()</script>`, "https://openrouter.ai"],
		["https://example.com'", "https://openrouter.ai"],
		['https://example.com"><script>attack()</script>', "https://openrouter.ai"],
		// The hostname regex rejects wildcard and list syntax that CSP would misread.
		["https://*.example.com", "https://openrouter.ai"],
		["https://a,b.com", "https://openrouter.ai"],
		// The protocol allowlist rejects non-http(s) schemes before the host is read.
		["javascript:attack()", "https://openrouter.ai"],
		["file:///tmp/test", "https://openrouter.ai"],
		["ftp://example.com", "https://openrouter.ai"],
		["ws://example.com", "https://openrouter.ai"],
		// Malformed input falls back to the default.
		["invalid", "https://openrouter.ai"],
		["", "https://openrouter.ai"],
	])("maps endpoint %s to origin %s", (baseUrl, origin) => {
		expect(getOpenRouterCspOrigin(baseUrl)).toBe(origin)
	})
})

describe("escapeCspAttribute", () => {
	it.each([
		["&", "&amp;"],
		['"', "&quot;"],
		["<", "&lt;"],
		[">", "&gt;"],
	])("escapes %s as %s", (raw, escaped) => {
		expect(escapeCspAttribute(`a ${raw} b`)).toBe(`a ${escaped} b`)
	})

	it("leaves safe characters unchanged", () => {
		expect(escapeCspAttribute("default-src 'none'; script-src 'nonce-abc'")).toBe(
			"default-src 'none'; script-src 'nonce-abc'",
		)
	})

	it("escapes every character so no raw markup survives", () => {
		expect(escapeCspAttribute('&"><script>')).toBe("&amp;&quot;&gt;&lt;script&gt;")
	})
})
