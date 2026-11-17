import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({}))

import { SecretStorageService, StoredMcpOAuthData } from "../SecretStorageService"

function createMockContext() {
	const store = new Map<string, string>()
	// Listeners registered via onDidChange; keyed by arbitrary id for disposal.
	const listeners = new Map<number, (e: { key: string }) => void>()
	let nextId = 0

	const secrets = {
		get: vi.fn(async (key: string) => store.get(key)),
		store: vi.fn(async (key: string, value: string) => {
			store.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key)
		}),
		onDidChange: vi.fn((handler: (e: { key: string }) => void) => {
			const id = nextId++
			listeners.set(id, handler)
			return { dispose: () => listeners.delete(id) }
		}),
		/** Test helper: simulate a storage change event. */
		_emit: (key: string) => {
			for (const handler of listeners.values()) handler({ key })
		},
	}

	return { secrets } as any
}

describe("SecretStorageService", () => {
	let service: SecretStorageService
	let context: ReturnType<typeof createMockContext>

	beforeEach(() => {
		context = createMockContext()
		service = new SecretStorageService(context)
	})

	describe("getOAuthData", () => {
		it("should return undefined when no data stored", async () => {
			const result = await service.getOAuthData("https://example.com/mcp")
			expect(result).toBeUndefined()
		})

		it("should return stored data", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "tok", token_type: "Bearer" },
				expires_at: Date.now() + 3600_000,
			}
			await service.saveOAuthData("https://example.com/mcp", data)

			const result = await service.getOAuthData("https://example.com/mcp")
			expect(result).toEqual(data)
		})

		it("should return undefined for malformed JSON", async () => {
			// Manually store garbage via the underlying mock (key uses base64url-encoded path)
			context.secrets.store("mcp.oauth.example.com.L21jcA.data", "not-json")

			const result = await service.getOAuthData("https://example.com/mcp")
			expect(result).toBeUndefined()
		})
	})

	describe("saveOAuthData", () => {
		it("should persist data under host and path-based key", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "abc", token_type: "Bearer" },
				expires_at: 12345,
			}
			await service.saveOAuthData("https://example.com/mcp", data)

			expect(context.secrets.store).toHaveBeenCalledWith(
				"mcp.oauth.example.com.L21jcA.data",
				JSON.stringify(data),
			)
		})

		it("should handle root path correctly", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "abc", token_type: "Bearer" },
				expires_at: 12345,
			}
			await service.saveOAuthData("https://example.com/", data)

			expect(context.secrets.store).toHaveBeenCalledWith("mcp.oauth.example.com.data", JSON.stringify(data))
		})
	})

	describe("hasOAuthData", () => {
		it("should return false when no data stored", async () => {
			expect(await service.hasOAuthData("https://example.com/mcp")).toBe(false)
		})

		it("should return true when data is stored", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "tok", token_type: "Bearer" },
				expires_at: Date.now() + 3600_000,
			}
			await service.saveOAuthData("https://example.com/mcp", data)
			expect(await service.hasOAuthData("https://example.com/mcp")).toBe(true)
		})

		it("should return false after data is deleted", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "tok", token_type: "Bearer" },
				expires_at: Date.now() + 3600_000,
			}
			await service.saveOAuthData("https://example.com/mcp", data)
			await service.deleteOAuthData("https://example.com/mcp")
			expect(await service.hasOAuthData("https://example.com/mcp")).toBe(false)
		})
	})

	describe("deleteOAuthData", () => {
		it("should delete stored data", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "tok", token_type: "Bearer" },
				expires_at: Date.now() + 3600_000,
			}
			await service.saveOAuthData("https://example.com/mcp", data)

			await service.deleteOAuthData("https://example.com/mcp")

			expect(context.secrets.delete).toHaveBeenCalledWith("mcp.oauth.example.com.L21jcA.data")
			const result = await service.getOAuthData("https://example.com/mcp")
			expect(result).toBeUndefined()
		})
	})

	describe("onDidChange", () => {
		it("should call the callback when the key for the given URL changes", () => {
			const cb = vi.fn()
			service.onDidChange("https://example.com/mcp", cb)

			context.secrets._emit("mcp.oauth.example.com.L21jcA.data")

			expect(cb).toHaveBeenCalledTimes(1)
		})

		it("should not call the callback for a different URL's key", () => {
			const cb = vi.fn()
			service.onDidChange("https://example.com/mcp", cb)

			context.secrets._emit("mcp.oauth.other.com.L21jcA.data")

			expect(cb).not.toHaveBeenCalled()
		})

		it("should stop calling the callback after the returned dispose function is called", () => {
			const cb = vi.fn()
			const unsubscribe = service.onDidChange("https://example.com/mcp", cb)

			unsubscribe()
			context.secrets._emit("mcp.oauth.example.com.L21jcA.data")

			expect(cb).not.toHaveBeenCalled()
		})
	})

	describe("client_info round-trip", () => {
		it("should persist and retrieve full client_info and resource indicator", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "tok", token_type: "Bearer" },
				expires_at: Date.now() + 3600_000,
				resource_indicator: "https://api.example.com/",
				client_info: {
					client_id: "cid-123",
					client_secret: "secret-456",
					client_name: "Test Client",
					redirect_uris: ["http://localhost:12345/callback"],
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					token_endpoint_auth_method: "client_secret_post",
				},
			}
			await service.saveOAuthData("https://example.com/mcp", data)

			const result = await service.getOAuthData("https://example.com/mcp")
			expect(result).toEqual(data)
			expect(result?.resource_indicator).toBe("https://api.example.com/")
			expect(result?.client_info?.client_id).toBe("cid-123")
			expect(result?.client_info?.client_secret).toBe("secret-456")
			expect(result?.client_info?.token_endpoint_auth_method).toBe("client_secret_post")
		})
	})

	describe("key isolation", () => {
		it("should isolate data by host", async () => {
			const data1: StoredMcpOAuthData = {
				tokens: { access_token: "a", token_type: "Bearer" },
				expires_at: 1,
			}
			const data2: StoredMcpOAuthData = {
				tokens: { access_token: "b", token_type: "Bearer" },
				expires_at: 2,
			}
			await service.saveOAuthData("https://host1.com/mcp", data1)
			await service.saveOAuthData("https://host2.com/mcp", data2)

			expect((await service.getOAuthData("https://host1.com/mcp"))?.tokens.access_token).toBe("a")
			expect((await service.getOAuthData("https://host2.com/mcp"))?.tokens.access_token).toBe("b")
		})

		it("should isolate data by path on the same host", async () => {
			const data1: StoredMcpOAuthData = {
				tokens: { access_token: "path1", token_type: "Bearer" },
				expires_at: 1,
			}
			const data2: StoredMcpOAuthData = {
				tokens: { access_token: "path2", token_type: "Bearer" },
				expires_at: 2,
			}
			await service.saveOAuthData("https://example.com/service1", data1)
			await service.saveOAuthData("https://example.com/service2", data2)

			expect((await service.getOAuthData("https://example.com/service1"))?.tokens.access_token).toBe("path1")
			expect((await service.getOAuthData("https://example.com/service2"))?.tokens.access_token).toBe("path2")
		})

		it("should not collide between paths that differ only in separators (/a-b, /a_b, /a/b)", async () => {
			const urls = ["https://example.com/a-b", "https://example.com/a_b", "https://example.com/a/b"]
			for (const [i, url] of urls.entries()) {
				await service.saveOAuthData(url, {
					tokens: { access_token: `tok-${i}`, token_type: "Bearer" },
					expires_at: i,
				})
			}

			for (const [i, url] of urls.entries()) {
				expect((await service.getOAuthData(url))?.tokens.access_token).toBe(`tok-${i}`)
			}
		})

		it("should not collide between a static root client ID and a legacy dynamic path", async () => {
			await service.saveOAuthData(
				"https://example.test/",
				{ tokens: { access_token: "static-token", token_type: "Bearer" }, expires_at: 1 },
				"/mcp",
			)

			expect(await service.getOAuthData("https://example.test/mcp")).toBeUndefined()

			await service.saveOAuthData("https://example.test/mcp", {
				tokens: { access_token: "dynamic-token", token_type: "Bearer" },
				expires_at: 2,
			})

			expect((await service.getOAuthData("https://example.test/", "/mcp"))?.tokens.access_token).toBe(
				"static-token",
			)
			expect((await service.getOAuthData("https://example.test/mcp"))?.tokens.access_token).toBe("dynamic-token")
		})

		it("should isolate static OAuth clients for the same server URL", async () => {
			await service.saveOAuthData(
				"https://example.com/mcp",
				{ tokens: { access_token: "client-a-token", token_type: "Bearer" }, expires_at: 1 },
				"client-a",
			)
			await service.saveOAuthData(
				"https://example.com/mcp",
				{ tokens: { access_token: "client-b-token", token_type: "Bearer" }, expires_at: 2 },
				"client-b",
			)

			expect((await service.getOAuthData("https://example.com/mcp", "client-a"))?.tokens.access_token).toBe(
				"client-a-token",
			)
			expect((await service.getOAuthData("https://example.com/mcp", "client-b"))?.tokens.access_token).toBe(
				"client-b-token",
			)
			expect(await service.getOAuthData("https://example.com/mcp")).toBeUndefined()
		})

		it("should isolate static OAuth credentials by URL scheme", async () => {
			await service.saveOAuthData(
				"http://example.com/mcp",
				{ tokens: { access_token: "http-token", token_type: "Bearer" }, expires_at: 1 },
				"shared-client",
			)
			await service.saveOAuthData(
				"https://example.com/mcp",
				{ tokens: { access_token: "https-token", token_type: "Bearer" }, expires_at: 2 },
				"shared-client",
			)

			expect((await service.getOAuthData("http://example.com/mcp", "shared-client"))?.tokens.access_token).toBe(
				"http-token",
			)
			expect((await service.getOAuthData("https://example.com/mcp", "shared-client"))?.tokens.access_token).toBe(
				"https-token",
			)
		})

		it("should isolate static OAuth credentials by URL query", async () => {
			await service.saveOAuthData(
				"https://example.com/mcp?tenant=a",
				{ tokens: { access_token: "tenant-a-token", token_type: "Bearer" }, expires_at: 1 },
				"shared-client",
			)
			await service.saveOAuthData(
				"https://example.com/mcp?tenant=b",
				{ tokens: { access_token: "tenant-b-token", token_type: "Bearer" }, expires_at: 2 },
				"shared-client",
			)

			expect(
				(await service.getOAuthData("https://example.com/mcp?tenant=a", "shared-client"))?.tokens.access_token,
			).toBe("tenant-a-token")
			expect(
				(await service.getOAuthData("https://example.com/mcp?tenant=b", "shared-client"))?.tokens.access_token,
			).toBe("tenant-b-token")
			expect(await service.getOAuthData("https://example.com/mcp", "shared-client")).toBeUndefined()
		})

		describe("per-client isolation on one server URL", () => {
			const url = "https://example.com/mcp"
			const dynamicKey = "mcp.oauth.example.com.L21jcA.data"
			// base64url("client-a") = Y2xpZW50LWE, base64url("client-b") = Y2xpZW50LWI
			const clientAKey = "mcp.oauth.https://example.com.p-L21jcA.c-Y2xpZW50LWE.data"
			const clientBKey = "mcp.oauth.https://example.com.p-L21jcA.c-Y2xpZW50LWI.data"
			const tokenData = (accessToken: string): StoredMcpOAuthData => ({
				tokens: { access_token: accessToken, token_type: "Bearer" },
				expires_at: 1,
			})

			it("should report hasOAuthData only for the client that stored data", async () => {
				await service.saveOAuthData(url, tokenData("client-a-token"), "client-a")

				expect(await service.hasOAuthData(url, "client-a")).toBe(true)
				expect(await service.hasOAuthData(url, "client-b")).toBe(false)
				expect(await service.hasOAuthData(url)).toBe(false)

				await service.saveOAuthData(url, tokenData("dynamic-token"))

				expect(await service.hasOAuthData(url)).toBe(true)
				expect(await service.hasOAuthData(url, "client-b")).toBe(false)
			})

			it("should delete only the entry for the given client", async () => {
				await service.saveOAuthData(url, tokenData("client-a-token"), "client-a")
				await service.saveOAuthData(url, tokenData("client-b-token"), "client-b")
				await service.saveOAuthData(url, tokenData("dynamic-token"))

				await service.deleteOAuthData(url, "client-a")

				expect(context.secrets.delete).toHaveBeenCalledWith(clientAKey)
				expect(await service.getOAuthData(url, "client-a")).toBeUndefined()
				expect((await service.getOAuthData(url, "client-b"))?.tokens.access_token).toBe("client-b-token")
				expect((await service.getOAuthData(url))?.tokens.access_token).toBe("dynamic-token")

				await service.deleteOAuthData(url)

				expect(context.secrets.delete).toHaveBeenLastCalledWith(dynamicKey)
				expect(await service.getOAuthData(url)).toBeUndefined()
				expect((await service.getOAuthData(url, "client-b"))?.tokens.access_token).toBe("client-b-token")
			})

			it("should fire onDidChange only for the subscribed client's key", () => {
				const onClientA = vi.fn()
				const onClientB = vi.fn()
				const onDynamic = vi.fn()
				service.onDidChange(url, onClientA, "client-a")
				service.onDidChange(url, onClientB, "client-b")
				service.onDidChange(url, onDynamic)

				context.secrets._emit(clientAKey)

				expect(onClientA).toHaveBeenCalledTimes(1)
				expect(onClientB).not.toHaveBeenCalled()
				expect(onDynamic).not.toHaveBeenCalled()

				context.secrets._emit(dynamicKey)

				expect(onDynamic).toHaveBeenCalledTimes(1)
				expect(onClientA).toHaveBeenCalledTimes(1)
				expect(onClientB).not.toHaveBeenCalled()

				context.secrets._emit(clientBKey)

				expect(onClientB).toHaveBeenCalledTimes(1)
				expect(onClientA).toHaveBeenCalledTimes(1)
				expect(onDynamic).toHaveBeenCalledTimes(1)
			})
		})
	})
})
