import * as fs from "fs/promises"
import type { Server } from "http"

import type { Mock } from "vitest"
import type { Uri } from "vscode"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import type { ClineProvider } from "../../../core/webview/ClineProvider"
import type { SecretStorageService, StoredMcpOAuthData } from "../SecretStorageService"
import type { CallbackResult } from "../utils/callbackServer"

import { McpHub } from "../McpHub"
import { McpOAuthClientProvider } from "../McpOAuthClientProvider"

// The module mock above stands in for the McpHub tests. The redirect property
// drives the real provider implementation, so it imports the actual module.
async function realProvider() {
	const actual = await vi.importActual<typeof import("../McpOAuthClientProvider")>("../McpOAuthClientProvider")
	return actual.McpOAuthClientProvider
}

// ---------------------------------------------------------------------------
// Module doubles, mirroring the sibling spec files in this folder.
// ---------------------------------------------------------------------------

vi.mock("fs/promises", () => {
	const access = vi.fn().mockRejectedValue(new Error("no project config"))
	const writeFile = vi.fn().mockResolvedValue(undefined)
	const readFile = vi.fn().mockResolvedValue("{}")
	const unlink = vi.fn().mockResolvedValue(undefined)
	const rename = vi.fn().mockResolvedValue(undefined)
	const lstat = vi.fn().mockImplementation(() => Promise.resolve({ isDirectory: () => true }))
	const mkdir = vi.fn().mockResolvedValue(undefined)
	const shared = { access, writeFile, readFile, unlink, rename, lstat, mkdir }
	return { default: shared, ...shared }
})

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn(async (filePath: string) => {
		const fsModule = await import("fs/promises")
		return fsModule.writeFile(filePath, "{}", "utf8")
	}),
}))

vi.mock("delay", () => ({ default: vi.fn().mockResolvedValue(undefined) }))

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidChange: vi.fn(),
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
		onDidSaveTextDocument: vi.fn(),
		onDidChangeWorkspaceFolders: vi.fn(),
		workspaceFolders: [],
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		withProgress: vi.fn().mockImplementation((_options: unknown, task: (p: unknown, t: unknown) => unknown) => {
			const progress = { report: vi.fn() }
			const token = {
				isCancellationRequested: false,
				onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
			}
			return task(progress, token)
		}),
	},
	env: {
		openExternal: vi.fn().mockResolvedValue(true),
	},
	Uri: {
		parse: vi.fn((url: string) => ({ toString: () => url })),
	},
	ProgressLocation: {
		Notification: 15,
	},
	Disposable: {
		from: vi.fn(),
	},
}))

vi.mock("../../../core/webview/ClineProvider")

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn(),
	getDefaultEnvironment: vi.fn().mockReturnValue({ PATH: "/usr/bin" }),
}))

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn(),
}))

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: vi.fn(),
}))

vi.mock("../McpOAuthClientProvider", () => ({
	McpOAuthClientProvider: {
		create: vi.fn(),
		isKnownNonOAuth: vi.fn().mockReturnValue(false),
		clearNonOAuthCache: vi.fn(),
	},
}))

vi.mock("chokidar", () => ({
	default: {
		watch: vi.fn().mockReturnValue({
			on: vi.fn().mockReturnThis(),
			close: vi.fn(),
		}),
	},
}))

vi.mock("../utils/callbackServer", () => ({
	startCallbackServer: vi.fn(),
	stopCallbackServer: vi.fn().mockResolvedValue(undefined),
}))

import * as vscode from "vscode"
import { startCallbackServer, stopCallbackServer } from "../utils/callbackServer"
import { TOKEN_EXPIRY_BUFFER_MS } from "../constants"

// ---------------------------------------------------------------------------
// Deterministic pseudo-random histories (mulberry32), seeded per property.
// ---------------------------------------------------------------------------

function makeRandom(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function pick<T>(random: () => number, items: readonly T[]): T {
	return items[Math.floor(random() * items.length)]
}

async function flushPromises(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// Provider doubles.
// ---------------------------------------------------------------------------

function createMockSecretStorage(): SecretStorageService {
	const store = new Map<string, string>()
	const key = (url: string, clientId?: string) => `${url}:${clientId ?? "dynamic"}`
	return {
		getOAuthData: vi.fn(async (url: string, clientId?: string) => {
			const raw = store.get(key(url, clientId))
			return raw ? (JSON.parse(raw) as StoredMcpOAuthData) : undefined
		}),
		saveOAuthData: vi.fn(async (url: string, data: StoredMcpOAuthData, clientId?: string) => {
			store.set(key(url, clientId), JSON.stringify(data))
		}),
		deleteOAuthData: vi.fn(async (url: string, clientId?: string) => {
			store.delete(key(url, clientId))
		}),
		hasOAuthData: vi.fn(async (url: string, clientId?: string) => store.has(key(url, clientId))),
		onDidChange: vi.fn(() => vi.fn()),
	} as unknown as SecretStorageService
}

/** Queues one callback listener whose port is 30000 + index. */
function queueListener(index: number): void {
	const server = { close: vi.fn((cb: () => void) => cb()) }
	const result = new Promise<CallbackResult>(() => {})
	vi.mocked(startCallbackServer).mockResolvedValueOnce({
		server: server as unknown as Server,
		port: 30000 + index,
		result,
		cancel: vi.fn(),
	})
}

const mockFetch = vi.fn()
const originalFetch = global.fetch
global.fetch = mockFetch

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
	discoverOAuthProtectedResourceMetadata: vi.fn().mockResolvedValue({
		resource: "",
		authorization_servers: ["https://auth.example.com"],
	}),
}))

function queueDiscoveryFetch(): void {
	mockFetch.mockResolvedValueOnce({
		ok: true,
		json: () =>
			Promise.resolve({
				issuer: "https://auth.example.com",
				authorization_endpoint: "https://auth.example.com/authorize",
				token_endpoint: "https://auth.example.com/token",
				token_endpoint_auth_methods_supported: ["none"],
				grant_types_supported: ["authorization_code", "refresh_token"],
			}),
	})
}

// ---------------------------------------------------------------------------
// Hub doubles for the flow and status properties.
// ---------------------------------------------------------------------------

const mockProvider = {
	ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
	postMessageToWebview: vi.fn(),
	getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
	context: {
		extension: { packageJSON: { version: "1.0.0" } },
	},
} as unknown as ClineProvider

function createTestSecretStorage(oauthData: unknown): SecretStorageService {
	return {
		hasOAuthData: vi.fn().mockResolvedValue(oauthData !== undefined),
		getOAuthData: vi.fn().mockResolvedValue(oauthData),
		deleteOAuthData: vi.fn().mockResolvedValue(undefined),
		onDidChange: vi.fn(() => vi.fn()),
	} as unknown as SecretStorageService
}

const serverName = "property-server"
const serverUrl = "https://property.example.com/mcp"
const oauthConfig = { type: "streamable-http", url: serverUrl }

type TestConnection = {
	type: "connected"
	server: { name: string; config: string; status: string; source?: string }
	client: { request: Mock; close: Mock }
	transport: { close: Mock }
	authProvider?: unknown
}

type FlowHandle = {
	connection: TestConnection
	authProvider: { close: Mock }
	cancellationToken?: { onCancellationRequested: Mock }
	promise: Promise<void>
	resolved: boolean
}

type FlowHub = {
	waitUntilReady: () => Promise<void>
	_runOAuthFlow: (
		name: string,
		source: "global" | "project",
		config: unknown,
		serverUrl: string,
		authProvider: unknown,
		transport: unknown,
		connection: unknown,
		progress: unknown,
		cancellationToken: unknown,
		oauthClientId?: string,
	) => Promise<void>
	deleteConnection: (name: string, source?: string) => Promise<void>
	notifyWebviewOfServerChanges: Mock
	findConnection: Mock
	validateServerConfig: Mock
	appendErrorMessage: Mock
	_oauthWatchers: Map<string, unknown>
	connections: TestConnection[]
	secretStorage: SecretStorageService
	dispose: () => Promise<void>
}

async function createFlowHub(): Promise<FlowHub> {
	const hub = new McpHub(mockProvider) as unknown as FlowHub
	// Settle the background initialization first: its updateServerConnections pass
	// would otherwise delete test connections that are absent from the settings file.
	await hub.waitUntilReady()
	hub.connections = []
	hub.secretStorage = createTestSecretStorage(undefined)
	hub.notifyWebviewOfServerChanges = vi.fn().mockResolvedValue(undefined)
	hub.findConnection = vi.fn(() => hub.connections[0])
	hub.validateServerConfig = vi.fn().mockReturnValue(oauthConfig)
	hub.appendErrorMessage = vi.fn().mockImplementation((connection: TestConnection, message: string) => {
		connection.server.status = "disconnected"
		void message
	})
	return hub
}

/** Starts one real _runOAuthFlow with a toast that never resolves. */
function startFlow(hub: FlowHub): FlowHandle {
	const connection: TestConnection = {
		type: "connected",
		server: { name: serverName, config: JSON.stringify(oauthConfig), status: "connecting", source: "global" },
		client: { request: vi.fn(), close: vi.fn().mockResolvedValue(undefined) },
		transport: { close: vi.fn().mockResolvedValue(undefined) },
	}
	const authProvider = { close: vi.fn().mockResolvedValue(undefined) }
	hub.connections = [connection]
	const cancellationToken = {
		isCancellationRequested: false,
		onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
	}
	const flowPromise = hub._runOAuthFlow(
		serverName,
		"global",
		oauthConfig,
		serverUrl,
		authProvider,
		{},
		connection,
		{ report: vi.fn() },
		cancellationToken,
		undefined,
	)
	const handle: FlowHandle = {
		connection,
		authProvider,
		cancellationToken,
		promise: flowPromise,
		resolved: false,
	}
	void flowPromise.then(() => {
		handle.resolved = true
	})
	return handle
}

// ---------------------------------------------------------------------------
// The properties, one per invariant sentence in the TLA+ specs.
// ---------------------------------------------------------------------------

describe("MCP OAuth flow property tests", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockFetch.mockReset()
		vi.mocked(startCallbackServer).mockReset()
		vi.mocked(stopCallbackServer).mockReset().mockResolvedValue(undefined)
		McpOAuthClientProvider.clearNonOAuthCache()
	})

	// Invariant: McpOAuthRedirectUrl.NoBadOpen.
	it("redirect property: every opened URL carries the active listener port and never port 0", async () => {
		const random = makeRandom(20261127)
		const histories = 24

		for (let history = 0; history < histories; history++) {
			// The client registration may be cached, which skips DCR entirely.
			const cached = random() < 0.5
			const secretStorage = createMockSecretStorage()
			queueDiscoveryFetch()
			if (cached) {
				await secretStorage.saveOAuthData("https://example.com/mcp", {
					tokens: { access_token: "seed", token_type: "Bearer" },
					expires_at: Date.now() + TOKEN_EXPIRY_BUFFER_MS + 60 * 1000,
					issuer: "https://auth.example.com",
					client_info: { client_id: "cached-client", redirect_uris: [] },
				} as StoredMcpOAuthData)
			}
			queueListener(0)
			const RealProvider = await realProvider()
			const provider = await RealProvider.create("https://example.com/mcp", secretStorage)

			// A later 401 round re-auths through a replacement listener.
			const rounds = 1 + Math.floor(random() * 2)
			for (let round = 0; round < rounds; round++) {
				if (round > 0) {
					await provider.close()
					queueListener(round)
				}
				const url = new URL(
					"https://auth.example.com/authorize?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A0%2Fcallback",
				)
				await provider.redirectToAuthorization(url)
				const redirectUri = url.searchParams.get("redirect_uri") ?? ""
				const redirectPort = Number(new URL(redirectUri).port)
				expect(redirectPort).toBe(30000 + round)
				expect(redirectPort).not.toBe(0)

				// The opened URL is the stored one.
				await provider.openBrowser()
				const openedUri = vi.mocked(vscode.env.openExternal).mock.calls.at(-1)?.[0] as Uri
				expect(new URL(String(openedUri)).searchParams.get("redirect_uri")).toBe(
					`http://127.0.0.1:${30000 + round}/callback`,
				)
			}
			await provider.close()
		}
	})

	// Invariants: McpOAuthFlowEnd.NoDuplicateFlow, NoOrphanFlow, ToolNotOrphaned.
	it("flow-end property: a removed watcher always ends its flow, and tool waits are released", async () => {
		const random = makeRandom(486)
		const histories = 16
		const actions = ["start", "replace", "delete", "tool", "dispose"] as const

		for (let history = 0; history < histories; history++) {
			const hub = await createFlowHub()
			const flows: FlowHandle[] = []
			let toolWaiting = false

			const steps = 3 + Math.floor(random() * 4)
			for (let step = 0; step < steps; step++) {
				const action = pick(random, actions)
				if (action === "start" || action === "replace" || action === "tool") {
					if (action === "tool") {
						toolWaiting = true
					}
					// Starting a flow replaces any existing watcher through the shared path.
					flows.push(startFlow(hub))
				} else if (action === "delete") {
					await hub.deleteConnection(serverName, "global")
				} else {
					// Dispose ends every flow; the history stops here.
					await hub.dispose()
					await flushPromises()
					break
				}
				await flushPromises()

				// NoDuplicateFlow: at most one unresolved flow.
				const unresolved = flows.filter((flow) => !flow.resolved)
				expect(unresolved.length).toBeLessThanOrEqual(1)
				// NoOrphanFlow: a pending flow still owns the watcher.
				expect(unresolved.length === 1).toBe(hub._oauthWatchers.size === 1)
				// ToolNotOrphaned: a tool wait is live on a flow or was released by its end.
				if (toolWaiting) {
					expect(hub._oauthWatchers.size === 1 || unresolved.length === 0).toBe(true)
				}
			}

			// Every flow promise settles once the hub goes away.
			await hub.dispose()
			await flushPromises()
			for (const flow of flows) {
				await flow.promise
				expect(flow.resolved).toBe(true)
			}
		}
	})

	// Invariant: McpOAuthFlowEnd.NoErrorLeak.
	it("error-leak property: a reconnect error in the token watcher ends the flow", async () => {
		const random = makeRandom(987654321)
		const histories = 8

		for (let history = 0; history < histories; history++) {
			const hub = await createFlowHub()
			const flow = startFlow(hub)
			await flushPromises()
			expect(hub._oauthWatchers.size).toBe(1)

			// The token watcher fires and the reconnect it triggers throws.
			const secretStorage = hub.secretStorage
			;(secretStorage.getOAuthData as Mock).mockResolvedValue({
				expires_at: Date.now() + 10 * 60 * 1000,
			})
			const watcherCallbacks = (secretStorage.onDidChange as Mock).mock.calls.map((call) => call[1] as () => void)
			expect(watcherCallbacks.length).toBe(1)
			watcherCallbacks[0]()
			await flushPromises()
			await flushPromises()
			void random

			expect(flow.resolved).toBe(true)
			expect(hub._oauthWatchers.size).toBe(0)
			await hub.dispose()
		}
	})

	// Invariant: McpOAuthStatusHandoff.PanelShowsConnected.
	it("status-handoff property: the panel shows connected before slow lists finish, then updates again", async () => {
		const random = makeRandom(13579)
		const histories = 10

		const streamableModule = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
		const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")

		for (let history = 0; history < histories; history++) {
			// The lists finish in a random order, possibly after other work.
			const toolsDeferred = deferred()
			const resourcesDeferred = deferred()
			vi.mocked(streamableModule.StreamableHTTPClientTransport).mockImplementation(function () {
				return { close: vi.fn().mockResolvedValue(undefined) } as unknown as StreamableHTTPClientTransport
			})
			vi.mocked(clientModule.Client).mockImplementation(function () {
				return {
					connect: vi.fn().mockResolvedValue(undefined),
					close: vi.fn().mockResolvedValue(undefined),
					getInstructions: vi.fn(),
					request: vi.fn((request: { method: string }) => {
						if (request.method === "tools/list") return toolsDeferred.promise
						return resourcesDeferred.promise
					}),
				} as unknown as Client
			})
			const authProvider = {
				hasMetadata: true,
				registerClientIfNeeded: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
			}
			vi.mocked(McpOAuthClientProvider.create).mockResolvedValue(
				authProvider as unknown as McpOAuthClientProvider,
			)

			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ mcpServers: { [serverName]: oauthConfig } }))
			const hub = new McpHub(mockProvider, createTestSecretStorage(undefined))
			const hubDouble = hub as unknown as {
				notifyWebviewOfServerChanges: Mock
				connections: Array<{ server: { name: string; status: string; tools?: unknown } }>
				dispose: () => Promise<void>
			}
			const notifySpy = vi.spyOn(hubDouble, "notifyWebviewOfServerChanges").mockResolvedValue(undefined)

			try {
				const ready = hub.waitUntilReady()
				const conn = () => hubDouble.connections.find((c) => c.server.name === serverName)

				// PanelShowsConnected: connected at the status change, before any list.
				await vi.waitFor(() => {
					expect(conn()?.server.status).toBe("connected")
					expect(notifySpy).toHaveBeenCalledTimes(1)
				})
				expect(conn()?.server.tools).toBeUndefined()

				// The lists finish in a random order and the panel updates again.
				const order = random() < 0.5 ? [toolsDeferred, resourcesDeferred] : [resourcesDeferred, toolsDeferred]
				for (const entry of order) {
					entry.resolve()
					await flushPromises()
				}
				await ready
				await vi.waitFor(() => expect(notifySpy.mock.calls.length).toBeGreaterThanOrEqual(2))
				expect(conn()?.server.tools).toEqual([])
			} finally {
				await hubDouble.dispose()
			}
		}
	})
})

function deferred(): { promise: Promise<Record<string, never>>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<Record<string, never>>((res) => {
		resolve = res as () => void
	})
	return { promise, resolve }
}

afterAll(async () => {
	global.fetch = originalFetch
})
