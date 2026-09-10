import { Package } from "@roo/package"

import { getCallbackUrl, getOpenRouterAuthUrl, getRequestyAuthUrl, getZooCodeAuthUrl } from "../urls"

describe("OAuth URLs", () => {
	it.each([undefined, "", "vscode-insiders", "cursor"])("encodes callback URLs for scheme %s", (scheme) => {
		expect(getCallbackUrl("auth-callback", scheme)).toBe(
			encodeURIComponent(`${scheme || "vscode"}://${Package.publisher}.${Package.name}/auth-callback`),
		)
	})

	it.each([
		[getOpenRouterAuthUrl, "https://openrouter.ai/auth", "openrouter"],
		[getRequestyAuthUrl, "https://app.requesty.ai/oauth/authorize", "requesty"],
	] as const)("preserves the endpoint and provider callback for %s", (getAuthUrl, endpoint, identifier) => {
		for (const scheme of [undefined, "", "vscode-insiders", "cursor"]) {
			const callback = `${scheme || "vscode"}://${Package.publisher}.${Package.name}/${identifier}`
			expect(getAuthUrl(scheme)).toBe(`${endpoint}?callback_url=${encodeURIComponent(callback)}`)
			expect(new URL(getAuthUrl(scheme)).searchParams.get("callback_url")).toBe(callback)
		}
	})

	it("uses default Zoo connection settings", () => {
		const url = new URL(getZooCodeAuthUrl())
		expect(url.origin + url.pathname).toBe("https://www.zoocode.dev/dashboard/connect")
		expect(Object.fromEntries(url.searchParams)).toEqual({
			device: "VS Code",
			editor: "VS Code",
			version: Package.version,
			callback_uri: `vscode://${Package.publisher}.${Package.name}/auth-callback`,
		})
		expect(getZooCodeAuthUrl("", "", "")).toBe(getZooCodeAuthUrl())
	})

	it("encodes custom device names and uses the supplied Zoo host and editor scheme", () => {
		const url = new URL(getZooCodeAuthUrl("cursor", "https://example.com", "Work & Home / ноутбук"))
		expect(url.origin + url.pathname).toBe("https://example.com/dashboard/connect")
		expect(Object.fromEntries(url.searchParams)).toEqual({
			device: "Work & Home / ноутбук",
			editor: "VS Code",
			version: Package.version,
			callback_uri: `cursor://${Package.publisher}.${Package.name}/auth-callback`,
		})
	})
})
