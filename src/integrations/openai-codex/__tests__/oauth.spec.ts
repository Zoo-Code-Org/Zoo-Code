import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { ExtensionContext } from "vscode"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	exchangeCodeForTokens,
	OpenAiCodexOAuthManager,
	refreshAccessToken,
	type OpenAiCodexCredentials,
} from "../oauth"

const CREDENTIALS_KEY = "openai-codex-oauth-credentials"

class SharedSecretStorage {
	private readonly values = new Map<string, string>()
	storeGate: Promise<void> | null = null
	storeError: Error | null = null
	storeAttempts = 0
	deleteAttempts = 0

	async get(key: string): Promise<string | undefined> {
		return this.values.get(key)
	}

	async store(key: string, value: string): Promise<void> {
		this.storeAttempts++
		await this.storeGate
		if (this.storeError) {
			throw this.storeError
		}
		this.values.set(key, value)
	}

	async delete(key: string): Promise<void> {
		this.deleteAttempts++
		this.values.delete(key)
	}

	setCredentials(credentials: OpenAiCodexCredentials): void {
		this.values.set(CREDENTIALS_KEY, JSON.stringify(credentials))
	}

	getCredentials(): OpenAiCodexCredentials | null {
		const credentials = this.values.get(CREDENTIALS_KEY)
		return credentials ? (JSON.parse(credentials) as OpenAiCodexCredentials) : null
	}
}

function createCredentials({
	accessToken = "at0",
	refreshToken = "rt0",
	expires = Date.now() - 1,
}: {
	accessToken?: string
	refreshToken?: string
	expires?: number
} = {}): OpenAiCodexCredentials {
	return {
		type: "openai-codex",
		access_token: accessToken,
		refresh_token: refreshToken,
		expires,
	}
}

function createContext(globalStoragePath: string, secrets: SharedSecretStorage): ExtensionContext {
	return {
		globalStorageUri: { fsPath: globalStoragePath },
		secrets,
	} as unknown as ExtensionContext
}

function createTokenResponse(accessToken: string, refreshToken: string): Response {
	return new Response(
		JSON.stringify({
			access_token: accessToken,
			refresh_token: refreshToken,
			expires_in: 3600,
		}),
		{ status: 200 },
	)
}

function createInvalidGrantResponse(): Response {
	return new Response(JSON.stringify({ error: "invalid_grant" }), {
		status: 400,
		statusText: "Bad Request",
	})
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 200; attempts++) {
		if (condition()) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("Timed out waiting for condition")
}

describe("OpenAiCodexOAuthManager", () => {
	let globalStoragePath: string

	beforeEach(async () => {
		globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "roo-codex-oauth-"))
	})

	afterEach(async () => {
		vi.unstubAllGlobals()
		await fs.rm(globalStoragePath, { recursive: true, force: true })
	})

	it("keeps one in-process refresh live until rotated credentials are persisted", async () => {
		const secrets = new SharedSecretStorage()
		secrets.setCredentials(createCredentials())
		const persistGate = deferred()
		secrets.storeGate = persistGate.promise
		const fetchMock = vi.fn().mockResolvedValue(createTokenResponse("at1", "rt1"))
		vi.stubGlobal("fetch", fetchMock)
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(createContext(globalStoragePath, secrets))

		const first = manager.getAccessToken()
		await waitFor(() => secrets.storeAttempts === 1)
		const second = manager.getAccessToken()

		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(fetchMock).toHaveBeenCalledTimes(1)

		persistGate.resolve()
		await expect(Promise.all([first, second])).resolves.toEqual(["at1", "at1"])
		expect(secrets.getCredentials()?.refresh_token).toBe("rt1")
	})

	it("does not report a rotated token when persistence fails", async () => {
		const secrets = new SharedSecretStorage()
		secrets.setCredentials(createCredentials())
		secrets.storeError = new Error("storage unavailable")
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createTokenResponse("at1", "rt1")))
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(createContext(globalStoragePath, secrets))

		await expect(manager.getAccessToken()).resolves.toBeNull()
		expect(secrets.getCredentials()?.refresh_token).toBe("rt0")
	})

	it("serializes refresh across managers sharing one durable credential", async () => {
		const secrets = new SharedSecretStorage()
		secrets.setCredentials(createCredentials())
		const fetchMock = vi.fn().mockResolvedValue(createTokenResponse("at1", "rt1"))
		vi.stubGlobal("fetch", fetchMock)
		const first = new OpenAiCodexOAuthManager()
		const second = new OpenAiCodexOAuthManager()
		first.initialize(createContext(globalStoragePath, secrets))
		second.initialize(createContext(globalStoragePath, secrets))
		await Promise.all([first.loadCredentials(), second.loadCredentials()])

		await expect(Promise.all([first.getAccessToken(), second.getAccessToken()])).resolves.toEqual(["at1", "at1"])
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(new URLSearchParams(fetchMock.mock.calls[0][1].body).get("refresh_token")).toBe("rt0")
	})

	it("lets a strict forced refresh run after an ordinary in-process refresh", async () => {
		const secrets = new SharedSecretStorage()
		secrets.setCredentials(createCredentials())
		const responseGate = deferred()
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async () => {
				await responseGate.promise
				return createTokenResponse("at1", "rt1")
			})
			.mockResolvedValueOnce(createTokenResponse("at2", "rt2"))
		vi.stubGlobal("fetch", fetchMock)
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(createContext(globalStoragePath, secrets))

		const ordinary = manager.getAccessToken()
		await waitFor(() => fetchMock.mock.calls.length === 1)
		const forced = manager.forceRefreshAccessToken()
		responseGate.resolve()

		await expect(Promise.all([ordinary, forced])).resolves.toEqual(["at1", "at2"])
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(new URLSearchParams(fetchMock.mock.calls[1][1].body).get("refresh_token")).toBe("rt1")
	})

	it("lets a forced waiter adopt another manager's rotated credential", async () => {
		const secrets = new SharedSecretStorage()
		secrets.setCredentials(createCredentials({ expires: Date.now() + 3600_000 }))
		const fetchMock = vi.fn().mockResolvedValue(createTokenResponse("at1", "rt1"))
		vi.stubGlobal("fetch", fetchMock)
		const first = new OpenAiCodexOAuthManager()
		const second = new OpenAiCodexOAuthManager()
		first.initialize(createContext(globalStoragePath, secrets))
		second.initialize(createContext(globalStoragePath, secrets))
		await Promise.all([first.loadCredentials(), second.loadCredentials()])

		await expect(Promise.all([first.forceRefreshAccessToken(), second.forceRefreshAccessToken()])).resolves.toEqual(
			["at1", "at1"],
		)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("preserves a newer stored credential after an invalid_grant response", async () => {
		const secrets = new SharedSecretStorage()
		secrets.setCredentials(createCredentials())
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => {
				secrets.setCredentials(
					createCredentials({ accessToken: "at1", refreshToken: "rt1", expires: Date.now() + 3600_000 }),
				)
				return createInvalidGrantResponse()
			}),
		)
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(createContext(globalStoragePath, secrets))

		await expect(manager.getAccessToken()).resolves.toBe("at1")
		expect(secrets.getCredentials()?.refresh_token).toBe("rt1")
		expect(secrets.deleteAttempts).toBe(0)
	})

	it("preserves a newer stored access token even when the refresh token did not rotate", async () => {
		const secrets = new SharedSecretStorage()
		secrets.setCredentials(createCredentials())
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => {
				secrets.setCredentials(createCredentials({ accessToken: "at1", expires: Date.now() + 3600_000 }))
				return createInvalidGrantResponse()
			}),
		)
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(createContext(globalStoragePath, secrets))

		await expect(manager.getAccessToken()).resolves.toBe("at1")
		expect(secrets.getCredentials()?.refresh_token).toBe("rt0")
		expect(secrets.deleteAttempts).toBe(0)
	})

	it("clears the stored credential when its refresh token is rejected", async () => {
		const secrets = new SharedSecretStorage()
		secrets.setCredentials(createCredentials())
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createInvalidGrantResponse()))
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(createContext(globalStoragePath, secrets))

		await expect(manager.getAccessToken()).resolves.toBeNull()
		expect(secrets.getCredentials()).toBeNull()
		expect(secrets.deleteAttempts).toBe(1)
	})

	it("keeps the lock alive while a delayed refresh response is in flight", async () => {
		const secrets = new SharedSecretStorage()
		secrets.setCredentials(createCredentials())
		const responseGate = deferred()
		const fetchMock = vi.fn().mockImplementation(async () => {
			await responseGate.promise
			return createTokenResponse("at1", "rt1")
		})
		vi.stubGlobal("fetch", fetchMock)
		const lockOptions = { refreshLockStaleMs: 2000, refreshLockUpdateMs: 1000 }
		const first = new OpenAiCodexOAuthManager(lockOptions)
		const second = new OpenAiCodexOAuthManager(lockOptions)
		first.initialize(createContext(globalStoragePath, secrets))
		second.initialize(createContext(globalStoragePath, secrets))
		await Promise.all([first.loadCredentials(), second.loadCredentials()])

		const firstAccessToken = first.getAccessToken()
		await waitFor(() => fetchMock.mock.calls.length === 1)
		await new Promise((resolve) => setTimeout(resolve, 2400))
		const secondAccessToken = second.getAccessToken()
		await new Promise((resolve) => setTimeout(resolve, 150))

		expect(fetchMock).toHaveBeenCalledTimes(1)
		responseGate.resolve()
		await expect(Promise.all([firstAccessToken, secondAccessToken])).resolves.toEqual(["at1", "at1"])
		expect(fetchMock).toHaveBeenCalledTimes(1)
	}, 10_000)
})

describe("OpenAI Codex OAuth requests", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("identifies Roo Code on authorization-code and refresh requests", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(createTokenResponse("at0", "rt0"))
			.mockResolvedValueOnce(createTokenResponse("at1", "rt1"))
		vi.stubGlobal("fetch", fetchMock)

		await exchangeCodeForTokens("code", "verifier")
		await refreshAccessToken(createCredentials())

		expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toMatch(/^zoo-code\//)
		expect(fetchMock.mock.calls[1][1].headers["User-Agent"]).toMatch(/^zoo-code\//)
	})
})
