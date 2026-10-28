import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

// Mock the SDK's discoverOAuthProtectedResourceMetadata
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
	discoverOAuthProtectedResourceMetadata: vi.fn(),
}))

import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js"
import { fetchOAuthAuthServerMetadata } from "../oauth"

const mockFetch = vi.fn()
const originalFetch = global.fetch
global.fetch = mockFetch

const unauthorized = (wwwAuthenticate?: string) =>
	new Response(null, {
		status: 401,
		headers: wwwAuthenticate ? { "WWW-Authenticate": wwwAuthenticate } : {},
	})

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("fetchOAuthAuthServerMetadata", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterAll(() => {
		global.fetch = originalFetch
	})

	it("returns null when resource metadata has no authorization_servers", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://example.com/",
			authorization_servers: [],
		})

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")
		expect(result).toBeNull()
	})

	it("returns null when discoverOAuthProtectedResourceMetadata throws", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockRejectedValue(new Error("network error"))
		mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")
		expect(result).toBeNull()
		expect(discoverOAuthProtectedResourceMetadata).toHaveBeenCalledTimes(1)
	})

	it.each([
		'Bearer resource_metadata="https://example.com/core/.well-known/oauth-protected-resource/mcp"',
		'Bearer RESOURCE_METADATA="https://example.com/core/.well-known/oauth-protected-resource/mcp"',
		'bearer error="invalid_token", resource_metadata = "https://example.com/core/.well-known/oauth-protected-resource/mcp"',
	])("falls back to the resource_metadata URL from the 401 header: %s", async (wwwAuthenticate) => {
		vi.mocked(discoverOAuthProtectedResourceMetadata)
			.mockRejectedValueOnce(
				new Error("Resource server does not implement OAuth 2.0 Protected Resource Metadata."),
			)
			.mockResolvedValueOnce({
				resource: "https://example.com/core/mcp",
				authorization_servers: ["https://auth.example.com"],
			})
		const meta = { issuer: "https://auth.example.com" }
		mockFetch
			.mockResolvedValueOnce(unauthorized(wwwAuthenticate))
			.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(meta) })

		const result = await fetchOAuthAuthServerMetadata("https://example.com/core/mcp")

		const [probeUrl, probeInit] = mockFetch.mock.calls[0] as [string, RequestInit]
		expect(probeUrl).toBe("https://example.com/core/mcp")
		expect(probeInit).toMatchObject({
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		})
		expect(JSON.parse(probeInit.body as string)).toMatchObject({ jsonrpc: "2.0", method: "initialize" })
		expect(discoverOAuthProtectedResourceMetadata).toHaveBeenLastCalledWith("https://example.com/core/mcp", {
			resourceMetadataUrl: new URL("https://example.com/core/.well-known/oauth-protected-resource/mcp"),
		})
		expect(result).toEqual({ authServerMeta: meta, resourceIndicator: "https://example.com/core/mcp" })
	})

	it.each([
		["no WWW-Authenticate header", undefined],
		["no resource_metadata parameter", 'Bearer realm="mcp"'],
		["a non-Bearer challenge", 'Basic resource_metadata="https://example.com/metadata"'],
		["an invalid URL", 'Bearer resource_metadata="not a url"'],
	])("returns null when the 401 response has %s", async (_case, wwwAuthenticate) => {
		vi.mocked(discoverOAuthProtectedResourceMetadata).mockRejectedValueOnce(new Error("not found"))
		mockFetch.mockResolvedValueOnce(unauthorized(wwwAuthenticate))

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")

		expect(result).toBeNull()
		expect(discoverOAuthProtectedResourceMetadata).toHaveBeenCalledTimes(1)
	})

	it("gives the fallback its own timeout budget after a slow well-known lookup", async () => {
		vi.useFakeTimers()
		try {
			vi.mocked(discoverOAuthProtectedResourceMetadata)
				.mockImplementationOnce(() => delay(4_500).then(() => Promise.reject(new Error("not found"))))
				.mockImplementationOnce(() =>
					delay(1_000).then(() => ({
						resource: "https://example.com/mcp",
						authorization_servers: ["https://auth.example.com"],
					})),
				)
			const meta = { issuer: "https://auth.example.com" }
			mockFetch
				.mockResolvedValueOnce(unauthorized('Bearer resource_metadata="https://example.com/metadata"'))
				.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(meta) })

			const result = fetchOAuthAuthServerMetadata("https://example.com/mcp")
			await vi.advanceTimersByTimeAsync(6_000)

			await expect(result).resolves.toEqual({
				authServerMeta: meta,
				resourceIndicator: "https://example.com/mcp",
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it("returns null when a protected resource metadata lookup exceeds its timeout", async () => {
		vi.useFakeTimers()
		try {
			vi.mocked(discoverOAuthProtectedResourceMetadata).mockImplementationOnce(() => new Promise(() => {}))
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))

			const result = fetchOAuthAuthServerMetadata("https://example.com/mcp")
			await vi.advanceTimersByTimeAsync(5_000)

			await expect(result).resolves.toBeNull()
		} finally {
			vi.useRealTimers()
		}
	})

	it("constructs the RFC 8414 discovery URL correctly for an issuer with a path", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://mcp.kapa.ai/",
			authorization_servers: ["https://mcp.kapa.ai/auth/public"],
		})

		const mockMeta = {
			issuer: "https://mcp.kapa.ai/auth/public",
			registration_endpoint: "https://mcp.kapa.ai/auth/public/register",
		}
		mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockMeta) })

		const result = await fetchOAuthAuthServerMetadata("https://mcp.kapa.ai/mcp")

		// Verify the RFC 8414 §3.1 URL: well-known inserted between host and path
		expect(mockFetch).toHaveBeenCalledWith(
			"https://mcp.kapa.ai/.well-known/oauth-authorization-server/auth/public",
			expect.objectContaining({ headers: { Accept: "application/json" } }),
		)
		expect(result).toEqual({ authServerMeta: mockMeta, resourceIndicator: "https://mcp.kapa.ai/" })
	})

	it("constructs the RFC 8414 discovery URL correctly for an issuer without a path", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://auth.example.com/",
			authorization_servers: ["https://auth.example.com"],
		})

		const mockMeta = { issuer: "https://auth.example.com" }
		mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockMeta) })

		await fetchOAuthAuthServerMetadata("https://auth.example.com/mcp")

		expect(mockFetch).toHaveBeenCalledWith(
			"https://auth.example.com/.well-known/oauth-authorization-server",
			expect.any(Object),
		)
	})

	it("strips trailing slash from issuer path before inserting well-known", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://example.com/",
			authorization_servers: ["https://example.com/issuer/"],
		})

		mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

		await fetchOAuthAuthServerMetadata("https://example.com/mcp")

		expect(mockFetch).toHaveBeenCalledWith(
			"https://example.com/.well-known/oauth-authorization-server/issuer",
			expect.any(Object),
		)
	})

	it("returns null when the discovery endpoint returns a non-OK response", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://example.com/",
			authorization_servers: ["https://auth.example.com"],
		})

		mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")
		expect(result).toBeNull()
	})

	it("returns null when fetch throws", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://example.com/",
			authorization_servers: ["https://auth.example.com"],
		})

		mockFetch.mockRejectedValueOnce(new Error("connection refused"))

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")
		expect(result).toBeNull()
	})

	it("returns the parsed metadata and resource indicator on success", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://example.com/",
			authorization_servers: ["https://auth.example.com/oauth2"],
		})

		const meta = {
			issuer: "https://auth.example.com/oauth2",
			authorization_endpoint: "https://auth.example.com/oauth2/authorize",
			token_endpoint: "https://auth.example.com/oauth2/token",
			registration_endpoint: "https://auth.example.com/oauth2/register",
			token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			scopes_supported: ["openid"],
		}
		mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(meta) })

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")
		expect(result).toEqual({ authServerMeta: meta, resourceIndicator: "https://example.com/" })
	})

	it("returns null resourceIndicator when protected resource metadata has no resource field", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			authorization_servers: ["https://auth.example.com"],
			// no `resource` field
		})

		const meta = { issuer: "https://auth.example.com" }
		mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(meta) })

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")
		expect(result).toEqual({ authServerMeta: meta, resourceIndicator: null })
	})
})
