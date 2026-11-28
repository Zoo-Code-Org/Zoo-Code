import * as fs from "fs/promises"
import * as path from "path"

import type { Mock } from "vitest"
import type { ExtensionContext, Uri } from "vscode"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import type { ClineProvider } from "../../../core/webview/ClineProvider"
import type { SecretStorageService } from "../SecretStorageService"

import type { McpHub as McpHubType, McpConnection, ConnectedMcpConnection, DisconnectedMcpConnection } from "../McpHub"
import { ServerConfigSchema, McpHub } from "../McpHub"
import { McpOAuthFlow } from "../McpOAuthFlow"
import { McpOAuthClientProvider } from "../McpOAuthClientProvider"
import { OAUTH_FLOW_TIMEOUT_MS, OAUTH_TOKEN_RETRY_MAX_ATTEMPTS } from "../constants"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { t } from "../../../i18n"

type McpHubPrivate = {
	watchMcpSettingsFile: () => Promise<void>
}

// Mock fs/promises before importing anything that uses it.
// Named exports and the default export must share the same vi.fn() instances so that
// `import * as fs` (used by McpHub.ts) and `import fs` (default) both see the same mocks.
vi.mock("fs/promises", () => {
	const access = vi.fn().mockResolvedValue(undefined)
	const writeFile = vi.fn().mockResolvedValue(undefined)
	const readFile = vi.fn().mockResolvedValue("{}")
	const unlink = vi.fn().mockResolvedValue(undefined)
	const rename = vi.fn().mockResolvedValue(undefined)
	const lstat = vi.fn().mockImplementation(() => Promise.resolve({ isDirectory: () => true }))
	const mkdir = vi.fn().mockResolvedValue(undefined)
	const shared = { access, writeFile, readFile, unlink, rename, lstat, mkdir }
	return { default: shared, ...shared }
})

// Import safeWriteJson to use in mocks

// Mock safeWriteJson
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn(
		async (
			filePath: string,
			data: unknown,
			options?: { merge?: (existing: unknown, incoming: unknown) => unknown },
		) => {
			// Instead of trying to write to the file system, just call fs.writeFile mock
			// This avoids the complex file locking and temp file operations.
			// When a merge callback is provided, honor it: read the current on-disk
			// content via the fs.readFile mock (simulating the read under the lock)
			// and let the callback decide the final value.
			let value = data
			if (options?.merge) {
				let existing: unknown = null
				try {
					const fs = await import("fs/promises")
					existing = JSON.parse(await fs.readFile(filePath, "utf8"))
				} catch (error) {
					// Mirror the production safeWriteJson merge contract: only ENOENT
					// and SyntaxError are recoverable; an EACCES or I/O failure must
					// reject before the merge callback runs.
					// unknown-safe narrowing: no cast on the caught value (the "in"
					// check narrows to object & Record<"code", unknown>).
					const code =
						error && typeof error === "object" && "code" in error && typeof error.code === "string"
							? error.code
							: undefined
					if (!(error instanceof SyntaxError) && code !== "ENOENT") {
						throw error
					}
					existing = null
				}
				value = options.merge(existing, data)
			}
			const fs = await import("fs/promises")
			return fs.writeFile(filePath, JSON.stringify(value), "utf8")
		},
	),
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
		createTextEditorDecorationType: vi.fn().mockReturnValue({
			dispose: vi.fn(),
		}),
		withProgress: vi.fn().mockImplementation((_options: any, task: any) => {
			const progress = { report: vi.fn() }
			const tokenListeners: Array<() => void> = []
			const cancellationToken = {
				isCancellationRequested: false,
				onCancellationRequested: vi.fn((cb: () => void) => {
					tokenListeners.push(cb)
					return { dispose: vi.fn() }
				}),
				_fire: () => tokenListeners.forEach((cb) => cb()),
			}
			return task(progress, cancellationToken)
		}),
	},
	ProgressLocation: {
		Notification: 15,
	},
	Disposable: {
		from: vi.fn(),
	},
}))
vi.mock("../../../core/webview/ClineProvider")

// Mock the MCP SDK modules
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

// Mock chokidar
vi.mock("chokidar", () => ({
	default: {
		watch: vi.fn().mockReturnValue({
			on: vi.fn().mockReturnThis(),
			close: vi.fn(),
		}),
	},
}))

describe("McpHub", () => {
	let mcpHub: McpHubType
	let mockProvider: Partial<ClineProvider>

	// Store original console methods
	const originalConsoleError = console.error
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")

	beforeEach(async () => {
		vi.clearAllMocks()

		// Mock console.error to suppress error messages during tests
		console.error = vi.fn()

		const mockUri: Uri = {
			scheme: "file",
			authority: "",
			path: "/test/path",
			query: "",
			fragment: "",
			fsPath: "/test/path",
			with: vi.fn(),
			toJSON: vi.fn(),
		}

		mockProvider = {
			ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
			ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
			postMessageToWebview: vi.fn(),
			getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
			context: {
				subscriptions: [],
				workspaceState: {} as any,
				globalState: {} as any,
				secrets: {} as any,
				extensionUri: mockUri,
				extensionPath: "/test/path",
				storagePath: "/test/storage",
				globalStoragePath: "/test/global-storage",
				environmentVariableCollection: {} as any,
				extension: {
					id: "test-extension",
					extensionUri: mockUri,
					extensionPath: "/test/path",
					extensionKind: 1,
					isActive: true,
					packageJSON: {
						version: "1.0.0",
					},
					activate: vi.fn(),
					exports: undefined,
				} as any,
				asAbsolutePath: (path: string) => path,
				storageUri: mockUri,
				globalStorageUri: mockUri,
				logUri: mockUri,
				extensionMode: 1,
				logPath: "/test/path",
				languageModelAccessInformation: {} as any,
			} as ExtensionContext,
		}

		// Mock fs.readFile for initial settings
		vi.mocked(fs.readFile).mockResolvedValue(
			JSON.stringify({
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						alwaysAllow: ["allowed-tool"],
						disabledTools: ["disabled-tool"],
					},
				},
			}),
		)

		mcpHub = new McpHub(mockProvider as ClineProvider)
		await mcpHub.waitUntilReady()
	})

	afterEach(() => {
		// Restore original console methods
		console.error = originalConsoleError
		// Restore original platform
		if (originalPlatform) {
			Object.defineProperty(process, "platform", originalPlatform)
		}
	})

	it("should log settings watcher startup failures", async () => {
		const watcherError = new Error("watcher startup failed")
		const watchSpy = vi
			.spyOn(McpHub.prototype as unknown as McpHubPrivate, "watchMcpSettingsFile")
			.mockRejectedValueOnce(watcherError)
		vi.mocked(console.error).mockClear()

		const failingHub = new McpHub(mockProvider as ClineProvider)
		await failingHub.waitUntilReady()
		await Promise.resolve()

		expect(console.error).toHaveBeenCalledWith("[McpHub] Failed to watch MCP settings file:", watcherError)
		await failingHub.dispose()
		watchSpy.mockRestore()
	})

	describe("getMcpSettingsFilePath", () => {
		it("preserves a config written by a concurrent process during initial creation (#1371)", async () => {
			const settingsPath = path.join("/mock/settings/path", "mcp_settings.json")
			const concurrentConfig = {
				mcpServers: {
					"concurrent-server": { type: "stdio", command: "node", args: ["server.js"] },
				},
			}

			// Window A's existence check sees the settings file as absent...
			// (One-shot overrides: the factory defaults apply to all other tests.)
			vi.mocked(fs.access).mockRejectedValueOnce(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			// ...but by the time the locked read runs (safeWriteJson merge),
			// window B's config is already on disk.
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(concurrentConfig))

			const returnedPath = await mcpHub.getMcpSettingsFilePath()

			expect(returnedPath).toBe(settingsPath)
			// The creation write must carry the concurrent config, not the empty stub.
			expect(fs.writeFile).toHaveBeenCalledTimes(1)
			const [writtenPath, writtenData] = vi.mocked(fs.writeFile).mock.calls[0]
			expect(writtenPath).toBe(settingsPath)
			expect(JSON.parse(writtenData as string)).toEqual(concurrentConfig)
		})

		it("writes the default stub when no settings file exists yet", async () => {
			const settingsPath = path.join("/mock/settings/path", "mcp_settings.json")

			// Existence check and the locked read both see an absent file.
			vi.mocked(fs.access).mockRejectedValueOnce(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			vi.mocked(fs.readFile).mockRejectedValueOnce(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)

			const returnedPath = await mcpHub.getMcpSettingsFilePath()

			expect(returnedPath).toBe(settingsPath)
			expect(fs.writeFile).toHaveBeenCalledTimes(1)
			const [writtenPath, writtenData] = vi.mocked(fs.writeFile).mock.calls[0]
			expect(writtenPath).toBe(settingsPath)
			expect(JSON.parse(writtenData as string)).toEqual({ mcpServers: {} })
		})

		it("writes the default stub when the existing content has no mcpServers object", async () => {
			// Existence check sees an absent file, but the locked read finds content
			// that does not carry a mcpServers object (e.g. a torn or foreign write).
			vi.mocked(fs.access).mockRejectedValueOnce(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({ someOtherKey: true }))

			await mcpHub.getMcpSettingsFilePath()

			expect(fs.writeFile).toHaveBeenCalledTimes(1)
			const [, writtenData] = vi.mocked(fs.writeFile).mock.calls[0]
			expect(JSON.parse(writtenData as string)).toEqual({ mcpServers: {} })
		})

		it("writes the default stub when the existing mcpServers value is not an object", async () => {
			vi.mocked(fs.access).mockRejectedValueOnce(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({ mcpServers: "corrupted" }))

			await mcpHub.getMcpSettingsFilePath()

			expect(fs.writeFile).toHaveBeenCalledTimes(1)
			const [, writtenData] = vi.mocked(fs.writeFile).mock.calls[0]
			expect(JSON.parse(writtenData as string)).toEqual({ mcpServers: {} })
		})

		it("writes the default stub when the existing mcpServers value is an array", async () => {
			// Arrays satisfy `typeof === "object"`; an mcpServers map must be a
			// plain object, so an array is invalid and replaced by the stub
			// instead of being preserved and rejected by McpSettingsSchema later.
			vi.mocked(fs.access).mockRejectedValueOnce(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({ mcpServers: [] }))

			await mcpHub.getMcpSettingsFilePath()

			expect(fs.writeFile).toHaveBeenCalledTimes(1)
			const [, writtenData] = vi.mocked(fs.writeFile).mock.calls[0]
			expect(JSON.parse(writtenData as string)).toEqual({ mcpServers: {} })
		})

		it("writes the default stub when the existing mcpServers value is null", async () => {
			const settingsPath = path.join("/mock/settings/path", "mcp_settings.json")

			// `typeof null === "object"` and `!Array.isArray(null)` both hold, so only
			// the truthy check on mcpServers stops a null map from being written back
			// to disk: McpSettingsSchema (z.record) rejects `{ mcpServers: null }` on
			// the next load, so the stub must replace it instead of preserving it.
			vi.mocked(fs.access).mockRejectedValueOnce(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({ mcpServers: null }))

			const returnedPath = await mcpHub.getMcpSettingsFilePath()

			expect(returnedPath).toBe(settingsPath)
			expect(fs.writeFile).toHaveBeenCalledTimes(1)
			const [, writtenData] = vi.mocked(fs.writeFile).mock.calls[0]
			expect(JSON.parse(writtenData as string)).toEqual({ mcpServers: {} })
		})

		it("writes the default stub when the locked read encounters malformed JSON", async () => {
			const settingsPath = path.join("/mock/settings/path", "mcp_settings.json")

			// A torn or foreign write leaves the file unparseable. JSON.parse throws
			// SyntaxError, which the safeWriteJson merge contract treats as a
			// recoverable absence (existing = null) rather than an I/O failure — the
			// stub is written and creation succeeds.
			vi.mocked(fs.access).mockRejectedValueOnce(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			vi.mocked(fs.readFile).mockResolvedValueOnce("{ mcpServers: not-json")

			const returnedPath = await mcpHub.getMcpSettingsFilePath()

			expect(returnedPath).toBe(settingsPath)
			expect(fs.writeFile).toHaveBeenCalledTimes(1)
			const [, writtenData] = vi.mocked(fs.writeFile).mock.calls[0]
			expect(JSON.parse(writtenData as string)).toEqual({ mcpServers: {} })
		})

		it("rejects creation when the locked read fails with an I/O error (EACCES)", async () => {
			vi.mocked(fs.access).mockRejectedValueOnce(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			// The locked read fails with a real I/O error (not ENOENT): the
			// safeWriteJson mock mirrors the production contract — reject before
			// the merge callback runs instead of treating the file as absent.
			vi.mocked(fs.readFile).mockRejectedValueOnce(
				Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
			)

			await expect(mcpHub.getMcpSettingsFilePath()).rejects.toThrow("EACCES: permission denied")
			expect(fs.writeFile).not.toHaveBeenCalled()
		})
	})

	describe("static OAuth connection wiring", () => {
		it("passes static OAuth options, performs discovery, and skips dynamic registration", async () => {
			const streamableModule = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
			const StreamableHTTPClientTransport = streamableModule.StreamableHTTPClientTransport as ReturnType<
				typeof vi.fn
			>
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>
			const mockAuthProvider = {
				registerClientIfNeeded: vi.fn(),
				close: vi.fn().mockResolvedValue(undefined),
			}
			vi.mocked(McpOAuthClientProvider.create).mockResolvedValue(
				mockAuthProvider as unknown as McpOAuthClientProvider,
			)
			const mockTransport = { close: vi.fn().mockResolvedValue(undefined) }
			StreamableHTTPClientTransport.mockImplementation(function () {
				return mockTransport as unknown as StreamableHTTPClientTransport
			})
			Client.mockImplementation(function () {
				return {
					connect: vi.fn().mockResolvedValue(undefined),
					close: vi.fn().mockResolvedValue(undefined),
					getInstructions: vi.fn(),
					request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				} as unknown as Client
			})
			const secretStorage = {
				hasOAuthData: vi.fn().mockResolvedValue(false),
			} as unknown as SecretStorageService
			const oauth = {
				clientId: "registered-client",
				scope: "openid offline_access",
				redirectUri: "http://localhost:33418/callback",
				resource: false as const,
			}
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"static-oauth-server": {
							type: "streamable-http",
							url: "https://example.com/mcp",
							oauth,
						},
					},
				}),
			)

			const hub = new McpHub(mockProvider as ClineProvider, secretStorage)
			await hub.waitUntilReady()

			expect(McpOAuthClientProvider.create).toHaveBeenCalledWith(
				"https://example.com/mcp",
				secretStorage,
				"static-oauth-server",
				{ skipDiscovery: false, ...oauth },
			)
			expect(mockAuthProvider.registerClientIfNeeded).not.toHaveBeenCalled()
			expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
				new URL("https://example.com/mcp"),
				expect.objectContaining({ authProvider: mockAuthProvider }),
			)
		})

		it.each([
			{
				label: "a static client forces discovery despite the non-OAuth cache",
				clientId: "registered-client",
				hasStoredData: false,
				knownNonOAuth: true,
				expectedSkip: false,
			},
			{
				label: "a dynamic client skips discovery for a known non-OAuth server",
				clientId: undefined,
				hasStoredData: false,
				knownNonOAuth: true,
				expectedSkip: true,
			},
			{
				label: "stored OAuth data forces discovery despite the non-OAuth cache",
				clientId: undefined,
				hasStoredData: true,
				knownNonOAuth: true,
				expectedSkip: false,
			},
			{
				label: "an uncached dynamic server performs discovery",
				clientId: undefined,
				hasStoredData: false,
				knownNonOAuth: false,
				expectedSkip: false,
			},
		])("computes skipDiscovery: $label", async ({ clientId, hasStoredData, knownNonOAuth, expectedSkip }) => {
			const streamableModule = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
			const StreamableHTTPClientTransport = streamableModule.StreamableHTTPClientTransport as ReturnType<
				typeof vi.fn
			>
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>
			const mockAuthProvider = {
				registerClientIfNeeded: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
			}
			vi.mocked(McpOAuthClientProvider.create).mockResolvedValue(
				mockAuthProvider as unknown as McpOAuthClientProvider,
			)
			StreamableHTTPClientTransport.mockImplementation(function () {
				return { close: vi.fn().mockResolvedValue(undefined) } as unknown as StreamableHTTPClientTransport
			})
			Client.mockImplementation(function () {
				return {
					connect: vi.fn().mockResolvedValue(undefined),
					close: vi.fn().mockResolvedValue(undefined),
					getInstructions: vi.fn(),
					request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				} as unknown as Client
			})
			const hasOAuthData = vi.fn().mockResolvedValue(hasStoredData)
			const secretStorage = { hasOAuthData } as unknown as SecretStorageService
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"oauth-server": {
							type: "streamable-http",
							url: "https://example.com/mcp",
							...(clientId ? { oauth: { clientId } } : {}),
						},
					},
				}),
			)
			vi.mocked(McpOAuthClientProvider.isKnownNonOAuth).mockReturnValue(knownNonOAuth)

			try {
				const hub = new McpHub(mockProvider as ClineProvider, secretStorage)
				await hub.waitUntilReady()

				expect(hasOAuthData).toHaveBeenCalledWith("https://example.com/mcp", clientId)
				expect(McpOAuthClientProvider.create).toHaveBeenCalledWith(
					"https://example.com/mcp",
					secretStorage,
					"oauth-server",
					expect.objectContaining({ skipDiscovery: expectedSkip }),
				)
				// Dynamic registration runs only for a dynamic client that performed discovery.
				if (!clientId && !expectedSkip) {
					expect(mockAuthProvider.registerClientIfNeeded).toHaveBeenCalled()
				} else {
					expect(mockAuthProvider.registerClientIfNeeded).not.toHaveBeenCalled()
				}
			} finally {
				vi.mocked(McpOAuthClientProvider.isKnownNonOAuth).mockReturnValue(false)
			}
		})

		it("closes a static OAuth provider when the hub is disposed during provider creation", async () => {
			const streamableModule = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
			const StreamableHTTPClientTransport = streamableModule.StreamableHTTPClientTransport as ReturnType<
				typeof vi.fn
			>
			let resolveProvider!: (provider: McpOAuthClientProvider) => void
			vi.mocked(McpOAuthClientProvider.create).mockImplementationOnce(
				() =>
					new Promise<McpOAuthClientProvider>((resolve) => {
						resolveProvider = resolve
					}),
			)
			const mockAuthProvider = {
				registerClientIfNeeded: vi.fn(),
				close: vi.fn().mockResolvedValue(undefined),
			} as unknown as McpOAuthClientProvider
			const secretStorage = {
				hasOAuthData: vi.fn().mockResolvedValue(false),
			} as unknown as SecretStorageService
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"static-oauth-server": {
							type: "streamable-http",
							url: "https://example.com/mcp",
							oauth: { clientId: "registered-client" },
						},
					},
				}),
			)

			vi.mocked(StreamableHTTPClientTransport).mockClear()
			vi.mocked(fs.access).mockRejectedValue(new Error("no project config"))
			const hub = new McpHub(mockProvider as ClineProvider, secretStorage)
			await vi.waitFor(() => expect(resolveProvider).toBeTypeOf("function"))
			await hub.dispose()
			resolveProvider(mockAuthProvider)
			await hub.waitUntilReady()

			expect(mockAuthProvider.close).toHaveBeenCalledTimes(1)
			expect(StreamableHTTPClientTransport).not.toHaveBeenCalled()
			vi.mocked(fs.access).mockResolvedValue(undefined)
		})
	})

	describe("Discriminated union type handling", () => {
		it("should create connected connections with proper type", async () => {
			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(function () {
				return mockTransport
			})

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			const mockClient = {
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
			}

			Client.mockImplementation(function () {
				return mockClient
			})

			// Mock the config file read BEFORE creating McpHub to avoid racing
			// the constructor's initializeGlobalMcpServers()
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"union-test-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			// Create McpHub and wait for constructor init to complete
			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Find the connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "union-test-server")
			expect(connection).toBeDefined()

			// Type guard check - connected connections should have client and transport
			if (connection && connection.type === "connected") {
				expect(connection.client).toBeDefined()
				expect(connection.transport).toBeDefined()
				expect(connection.server.status).toBe("connected")
			} else {
				throw new Error("Connection should be of type 'connected'")
			}
		})

		it("should create disconnected connections for disabled servers", async () => {
			// Mock the config file read BEFORE creating McpHub to avoid racing
			// the constructor's initializeGlobalMcpServers()
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"disabled-union-server": {
							command: "node",
							args: ["test.js"],
							disabled: true,
						},
					},
				}),
			)

			// Create McpHub and wait for constructor init to complete
			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Find the connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "disabled-union-server")
			expect(connection).toBeDefined()

			// Type guard check - disconnected connections should have null client and transport
			if (connection && connection.type === "disconnected") {
				expect(connection.client).toBeNull()
				expect(connection.transport).toBeNull()
				expect(connection.server.status).toBe("disconnected")
				expect(connection.server.disabled).toBe(true)
			} else {
				throw new Error("Connection should be of type 'disconnected'")
			}
		})

		it("should handle type narrowing correctly in callTool", async () => {
			// Mock fs.readFile to return empty config so no servers are initialized
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {},
				}),
			)

			// Create McpHub and wait for constructor init to complete
			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Clear any connections that might have been created
			mcpHub.connections = []

			// Directly set up a connected connection
			const connectedConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					config: JSON.stringify({ command: "node", args: ["test.js"] }),
					status: "connected",
					source: "global",
					errorHistory: [],
				} as any,
				client: {
					request: vi.fn().mockResolvedValue({ result: "success" }),
				} as any,
				transport: {} as any,
			}

			// Add the connected connection
			mcpHub.connections = [connectedConnection]

			// Call tool should work with connected server
			const result = await mcpHub.callTool("test-server", "test-tool", {})
			expect(result).toEqual({ result: "success" })
			expect(connectedConnection.client.request).toHaveBeenCalled()

			// Now test with a disconnected connection
			const disconnectedConnection: DisconnectedMcpConnection = {
				type: "disconnected",
				server: {
					name: "disabled-server",
					config: JSON.stringify({ command: "node", args: ["test.js"], disabled: true }),
					status: "disconnected",
					disabled: true,
					source: "global",
					errorHistory: [],
				} as any,
				client: null,
				transport: null,
			}

			// Replace connections with disconnected one
			mcpHub.connections = [disconnectedConnection]

			// Call tool should fail with disconnected server
			await expect(mcpHub.callTool("disabled-server", "test-tool", {})).rejects.toThrow(
				"No connection found for server: disabled-server",
			)
		})
	})

	describe("File watcher cleanup", () => {
		it("should clean up file watchers when server is disabled", async () => {
			// Get the mocked chokidar
			const chokidar = (await import("chokidar")).default
			const mockWatcher = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn(),
			}
			vi.mocked(chokidar.watch).mockReturnValue(mockWatcher as any)

			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(function () {
				return mockTransport
			})

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			const mockClient = {
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
			}

			Client.mockImplementation(function () {
				return mockClient
			})

			// Create server with watchPaths
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"watcher-test-server": {
							command: "node",
							args: ["test.js"],
							watchPaths: ["/path/to/watch"],
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Verify watcher was created
			expect(chokidar.watch).toHaveBeenCalledWith(["/path/to/watch"], expect.any(Object))

			// Now disable the server
			await mcpHub.toggleServerDisabled("watcher-test-server", true)

			// Verify watcher was closed
			expect(mockWatcher.close).toHaveBeenCalled()
		})

		it("should clean up all file watchers when server is deleted", async () => {
			// Get the mocked chokidar
			const chokidar = (await import("chokidar")).default
			const mockWatcher1 = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn(),
			}
			const mockWatcher2 = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn(),
			}

			// Return different watchers for different paths
			let watcherIndex = 0
			vi.mocked(chokidar.watch).mockImplementation(() => {
				return (watcherIndex++ === 0 ? mockWatcher1 : mockWatcher2) as any
			})

			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(function () {
				return mockTransport
			})

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			const mockClient = {
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
			}

			Client.mockImplementation(function () {
				return mockClient
			})

			// Create server with multiple watchPaths
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"multi-watcher-server": {
							command: "node",
							args: ["test.js", "build/index.js"], // This will create a watcher for build/index.js
							watchPaths: ["/path/to/watch1", "/path/to/watch2"],
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Verify watchers were created
			expect(chokidar.watch).toHaveBeenCalled()

			// Delete the connection (this should clean up all watchers)
			await mcpHub.deleteConnection("multi-watcher-server")

			// Verify all watchers were closed
			expect(mockWatcher1.close).toHaveBeenCalled()
			expect(mockWatcher2.close).toHaveBeenCalled()
		})

		it("should not create file watchers for disabled servers on initialization", async () => {
			// Get the mocked chokidar
			const chokidar = (await import("chokidar")).default

			// Create disabled server with watchPaths
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"disabled-watcher-server": {
							command: "node",
							args: ["test.js"],
							watchPaths: ["/path/to/watch"],
							disabled: true,
						},
					},
				}),
			)

			vi.mocked(chokidar.watch).mockClear()

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Verify no watcher was created for disabled server
			expect(chokidar.watch).not.toHaveBeenCalled()
		})
	})

	describe("DisableReason enum usage", () => {
		it("should use MCP_DISABLED reason when MCP is globally disabled", async () => {
			// Mock provider with mcpEnabled: false
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: false })

			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"mcp-disabled-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Find the connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "mcp-disabled-server")
			expect(connection).toBeDefined()
			expect(connection?.type).toBe("disconnected")
			expect(connection?.server.status).toBe("disconnected")

			// The server should not be marked as disabled individually
			expect(connection?.server.disabled).toBeUndefined()
		})

		it("should use SERVER_DISABLED reason when server is individually disabled", async () => {
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"server-disabled-server": {
							command: "node",
							args: ["test.js"],
							disabled: true,
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Find the connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "server-disabled-server")
			expect(connection).toBeDefined()
			expect(connection?.type).toBe("disconnected")
			expect(connection?.server.status).toBe("disconnected")
			expect(connection?.server.disabled).toBe(true)
		})

		it("should handle both disable reasons correctly", async () => {
			// First test with MCP globally disabled
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: false })

			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"both-reasons-server": {
							command: "node",
							args: ["test.js"],
							disabled: true, // Server is also individually disabled
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Find the connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "both-reasons-server")
			expect(connection).toBeDefined()
			expect(connection?.type).toBe("disconnected")

			// When MCP is globally disabled, it takes precedence
			// The server's individual disabled state should be preserved
			expect(connection?.server.disabled).toBe(true)
		})
	})

	describe("Null safety improvements", () => {
		it("should handle null client safely in disconnected connections", async () => {
			// Mock fs.readFile to return a disabled server config
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"null-safety-server": {
							command: "node",
							args: ["test.js"],
							disabled: true,
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Wait for initialization
			await mcpHub.waitUntilReady()

			// The server should be created as a disconnected connection with null client/transport
			const connection = mcpHub.connections.find((conn) => conn.server.name === "null-safety-server")
			expect(connection).toBeDefined()
			expect(connection?.type).toBe("disconnected")

			// Type guard to ensure it's a disconnected connection
			if (connection?.type === "disconnected") {
				expect(connection.client).toBeNull()
				expect(connection.transport).toBeNull()
			}

			// Try to call tool on disconnected server
			await expect(mcpHub.callTool("null-safety-server", "test-tool", {})).rejects.toThrow(
				"No connection found for server: null-safety-server",
			)

			// Try to read resource on disconnected server
			await expect(mcpHub.readResource("null-safety-server", "test-uri")).rejects.toThrow(
				"No connection found for server: null-safety-server",
			)
		})

		it("should handle connection type checks safely", async () => {
			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(function () {
				return mockTransport
			})

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			const mockClient = {
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
			}

			Client.mockImplementation(function () {
				return mockClient
			})

			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"type-check-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Get the connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "type-check-server")
			expect(connection).toBeDefined()

			// Safe type checking
			if (connection?.type === "connected") {
				expect(connection.client).toBeDefined()
				expect(connection.transport).toBeDefined()
			} else if (connection?.type === "disconnected") {
				expect(connection.client).toBeNull()
				expect(connection.transport).toBeNull()
			}
		})

		it("should handle missing connections safely", async () => {
			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Try operations on non-existent server
			await expect(mcpHub.callTool("non-existent-server", "test-tool", {})).rejects.toThrow(
				"No connection found for server: non-existent-server",
			)

			await expect(mcpHub.readResource("non-existent-server", "test-uri")).rejects.toThrow(
				"No connection found for server: non-existent-server",
			)
		})

		it("should handle connection deletion safely", async () => {
			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(function () {
				return mockTransport
			})

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			const mockClient = {
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
			}

			Client.mockImplementation(function () {
				return mockClient
			})

			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"delete-safety-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Delete the connection
			await mcpHub.deleteConnection("delete-safety-server")

			// Verify connection is removed
			const connection = mcpHub.connections.find((conn) => conn.server.name === "delete-safety-server")
			expect(connection).toBeUndefined()

			// Verify transport and client were closed
			expect(mockTransport.close).toHaveBeenCalled()
			expect(mockClient.close).toHaveBeenCalled()
		})
	})

	describe("toggleToolAlwaysAllow", () => {
		it("should add tool to always allow list when enabling", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						alwaysAllow: [],
					},
				},
			}

			// Mock reading initial config
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

			// Set up mock connection without alwaysAllow
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					type: "stdio",
					command: "node",
					args: ["test.js"],
					source: "global",
				} as any,
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			await mcpHub.toggleToolAlwaysAllow("test-server", "global", "new-tool", true)

			// Verify the config was updated correctly
			const writeCalls = vi.mocked(fs.writeFile).mock.calls
			expect(writeCalls.length).toBeGreaterThan(0)

			// Find the write call
			const callToUse = writeCalls[writeCalls.length - 1]
			expect(callToUse).toBeTruthy()

			// The path might be normalized differently on different platforms,
			// so we'll just check that we have a call with valid content
			const writtenConfig = JSON.parse(callToUse[1] as string)
			expect(writtenConfig.mcpServers).toBeDefined()
			expect(writtenConfig.mcpServers["test-server"]).toBeDefined()
			expect(Array.isArray(writtenConfig.mcpServers["test-server"].alwaysAllow)).toBe(true)
			expect(writtenConfig.mcpServers["test-server"].alwaysAllow).toContain("new-tool")
		})

		it("should remove tool from always allow list when disabling", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						alwaysAllow: ["existing-tool"],
					},
				},
			}

			// Mock reading initial config
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

			// Set up mock connection
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					type: "stdio",
					command: "node",
					args: ["test.js"],
					alwaysAllow: ["existing-tool"],
					source: "global",
				} as any,
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			await mcpHub.toggleToolAlwaysAllow("test-server", "global", "existing-tool", false)

			// Verify the config was updated correctly
			const writeCalls = vi.mocked(fs.writeFile).mock.calls
			expect(writeCalls.length).toBeGreaterThan(0)

			// Find the write call
			const callToUse = writeCalls[writeCalls.length - 1]
			expect(callToUse).toBeTruthy()

			// The path might be normalized differently on different platforms,
			// so we'll just check that we have a call with valid content
			const writtenConfig = JSON.parse(callToUse[1] as string)
			expect(writtenConfig.mcpServers).toBeDefined()
			expect(writtenConfig.mcpServers["test-server"]).toBeDefined()
			expect(Array.isArray(writtenConfig.mcpServers["test-server"].alwaysAllow)).toBe(true)
			expect(writtenConfig.mcpServers["test-server"].alwaysAllow).not.toContain("existing-tool")
		})

		it("should initialize alwaysAllow if it does not exist", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
					},
				},
			}

			// Mock reading initial config
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

			// Set up mock connection
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					type: "stdio",
					command: "node",
					args: ["test.js"],
					alwaysAllow: [],
					source: "global",
				} as any,
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			await mcpHub.toggleToolAlwaysAllow("test-server", "global", "new-tool", true)

			// Verify the config was updated with initialized alwaysAllow
			// Find the write call with the normalized path
			const normalizedSettingsPath = "/mock/settings/path/cline_mcp_settings.json"
			const writeCalls = vi.mocked(fs.writeFile).mock.calls

			// Find the write call with the normalized path
			const writeCall = writeCalls.find((call: any) => call[0] === normalizedSettingsPath)
			const callToUse = writeCall || writeCalls[0]

			const writtenConfig = JSON.parse(callToUse[1] as string)
			expect(writtenConfig.mcpServers["test-server"].alwaysAllow).toBeDefined()
			expect(writtenConfig.mcpServers["test-server"].alwaysAllow).toContain("new-tool")
		})

		it("should mark all tools as always allowed when wildcard is present", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						alwaysAllow: ["*"],
					},
				},
			}

			// Mock reading config - needs to return for every read
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockConfig))

			// Set up mock connection with tools
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					type: "stdio",
					command: "node",
					args: ["test.js"],
					source: "global",
				} as any,
				client: {
					request: vi.fn().mockResolvedValue({
						tools: [
							{ name: "tool1", description: "Tool 1" },
							{ name: "tool2", description: "Tool 2" },
							{ name: "tool3", description: "Tool 3" },
						],
					}),
				} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			// Fetch tools list to test wildcard matching
			const tools = await mcpHub["fetchToolsList"]("test-server", "global")

			// All tools should be marked as always allowed
			expect(tools.length).toBe(3)
			expect(tools[0].alwaysAllow).toBe(true)
			expect(tools[1].alwaysAllow).toBe(true)
			expect(tools[2].alwaysAllow).toBe(true)
		})

		it("should support both wildcard and specific tool names in alwaysAllow", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						alwaysAllow: ["*", "specific-tool"],
					},
				},
			}

			// Mock reading config - needs to return for every read
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockConfig))

			// Set up mock connection with tools
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					type: "stdio",
					command: "node",
					args: ["test.js"],
					source: "global",
				} as any,
				client: {
					request: vi.fn().mockResolvedValue({
						tools: [
							{ name: "tool1", description: "Tool 1" },
							{ name: "specific-tool", description: "Specific Tool" },
						],
					}),
				} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			// Fetch tools list
			const tools = await mcpHub["fetchToolsList"]("test-server", "global")

			// All tools should be marked as always allowed due to wildcard
			expect(tools.length).toBe(2)
			expect(tools[0].alwaysAllow).toBe(true)
			expect(tools[1].alwaysAllow).toBe(true)
		})

		it("should only allow specific tools when no wildcard is present", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						alwaysAllow: ["allowed-tool"],
					},
				},
			}

			// Mock reading config - needs to return for every read
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockConfig))

			// Set up mock connection with tools
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					type: "stdio",
					command: "node",
					args: ["test.js"],
					source: "global",
				} as any,
				client: {
					request: vi.fn().mockResolvedValue({
						tools: [
							{ name: "allowed-tool", description: "Allowed Tool" },
							{ name: "not-allowed-tool", description: "Not Allowed Tool" },
						],
					}),
				} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			// Fetch tools list
			const tools = await mcpHub["fetchToolsList"]("test-server", "global")

			// Only the specifically allowed tool should be marked as always allowed
			expect(tools.length).toBe(2)
			expect(tools[0].alwaysAllow).toBe(true) // allowed-tool
			expect(tools[1].alwaysAllow).toBe(false) // not-allowed-tool
		})
	})

	describe("toggleToolEnabledForPrompt", () => {
		it("should add tool to disabledTools list when enabling", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						disabledTools: [],
					},
				},
			}

			// Set up mock connection
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					config: "test-server-config",
					status: "connected",
					source: "global",
				},
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			// Mock reading initial config
			;(fs.readFile as Mock).mockResolvedValueOnce(JSON.stringify(mockConfig))

			await mcpHub.toggleToolEnabledForPrompt("test-server", "global", "new-tool", false)

			// Verify the config was updated correctly
			const writeCalls = (fs.writeFile as Mock).mock.calls
			expect(writeCalls.length).toBeGreaterThan(0)

			// Find the write call
			const callToUse = writeCalls[writeCalls.length - 1]
			expect(callToUse).toBeTruthy()

			// The path might be normalized differently on different platforms,
			// so we'll just check that we have a call with valid content
			const writtenConfig = JSON.parse(callToUse[1])
			expect(writtenConfig.mcpServers).toBeDefined()
			expect(writtenConfig.mcpServers["test-server"]).toBeDefined()
			expect(Array.isArray(writtenConfig.mcpServers["test-server"].enabledForPrompt)).toBe(false)
			expect(writtenConfig.mcpServers["test-server"].disabledTools).toContain("new-tool")
		})

		it("should remove tool from disabledTools list when disabling", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						disabledTools: ["existing-tool"],
					},
				},
			}

			// Set up mock connection
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					config: "test-server-config",
					status: "connected",
					source: "global",
				},
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			// Mock reading initial config
			;(fs.readFile as Mock).mockResolvedValueOnce(JSON.stringify(mockConfig))

			await mcpHub.toggleToolEnabledForPrompt("test-server", "global", "existing-tool", true)

			// Verify the config was updated correctly
			const writeCalls = (fs.writeFile as Mock).mock.calls
			expect(writeCalls.length).toBeGreaterThan(0)

			// Find the write call
			const callToUse = writeCalls[writeCalls.length - 1]
			expect(callToUse).toBeTruthy()

			// The path might be normalized differently on different platforms,
			// so we'll just check that we have a call with valid content
			const writtenConfig = JSON.parse(callToUse[1])
			expect(writtenConfig.mcpServers).toBeDefined()
			expect(writtenConfig.mcpServers["test-server"]).toBeDefined()
			expect(Array.isArray(writtenConfig.mcpServers["test-server"].enabledForPrompt)).toBe(false)
			expect(writtenConfig.mcpServers["test-server"].disabledTools).not.toContain("existing-tool")
		})

		it("should initialize disabledTools if it does not exist", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
					},
				},
			}

			// Set up mock connection
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					config: "test-server-config",
					status: "connected",
					source: "global",
				},
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			// Mock reading initial config
			;(fs.readFile as Mock).mockResolvedValueOnce(JSON.stringify(mockConfig))

			// Call with false because of "true" is default value
			await mcpHub.toggleToolEnabledForPrompt("test-server", "global", "new-tool", false)

			// Verify the config was updated with initialized disabledTools
			// Find the write call with the normalized path
			const normalizedSettingsPath = "/mock/settings/path/cline_mcp_settings.json"
			const writeCalls = (fs.writeFile as Mock).mock.calls

			// Find the write call with the normalized path
			const writeCall = writeCalls.find((call) => call[0] === normalizedSettingsPath)
			const callToUse = writeCall || writeCalls[0]

			const writtenConfig = JSON.parse(callToUse[1])
			expect(writtenConfig.mcpServers["test-server"].disabledTools).toBeDefined()
			expect(writtenConfig.mcpServers["test-server"].disabledTools).toContain("new-tool")
		})
	})

	describe("server disabled state", () => {
		it("should toggle server disabled state", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						disabled: false,
					},
				},
			}

			// Mock reading initial config
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

			// Set up mock connection
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					type: "stdio",
					command: "node",
					args: ["test.js"],
					disabled: false,
					source: "global",
				} as any,
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			await mcpHub.toggleServerDisabled("test-server", true)

			// Verify the config was updated correctly
			// Find the write call with the normalized path
			const normalizedSettingsPath = "/mock/settings/path/cline_mcp_settings.json"
			const writeCalls = vi.mocked(fs.writeFile).mock.calls

			// Find the write call with the normalized path
			const writeCall = writeCalls.find((call: any) => call[0] === normalizedSettingsPath)
			const callToUse = writeCall || writeCalls[0]

			const writtenConfig = JSON.parse(callToUse[1] as string)
			expect(writtenConfig.mcpServers["test-server"].disabled).toBe(true)
		})

		it("should filter out disabled servers from getServers", () => {
			const mockConnections: McpConnection[] = [
				{
					type: "connected",
					server: {
						name: "enabled-server",
						config: "{}",
						status: "connected",
						disabled: false,
					},
					client: {} as any,
					transport: {} as any,
				} as ConnectedMcpConnection,
				{
					type: "disconnected",
					server: {
						name: "disabled-server",
						config: "{}",
						status: "disconnected",
						disabled: true,
					},
					client: null,
					transport: null,
				} as DisconnectedMcpConnection,
			]

			mcpHub.connections = mockConnections
			const servers = mcpHub.getServers()

			expect(servers.length).toBe(1)
			expect(servers[0].name).toBe("enabled-server")
		})

		it("should deduplicate servers by name with project servers taking priority", () => {
			const mockConnections: McpConnection[] = [
				{
					type: "connected",
					server: {
						name: "shared-server",
						config: '{"source":"global"}',
						status: "connected",
						disabled: false,
						source: "global",
					},
					client: {} as any,
					transport: {} as any,
				} as ConnectedMcpConnection,
				{
					type: "connected",
					server: {
						name: "shared-server",
						config: '{"source":"project"}',
						status: "connected",
						disabled: false,
						source: "project",
					},
					client: {} as any,
					transport: {} as any,
				} as ConnectedMcpConnection,
				{
					type: "connected",
					server: {
						name: "unique-global-server",
						config: "{}",
						status: "connected",
						disabled: false,
						source: "global",
					},
					client: {} as any,
					transport: {} as any,
				} as ConnectedMcpConnection,
			]

			mcpHub.connections = mockConnections
			const servers = mcpHub.getServers()

			// Should have 2 servers: deduplicated "shared-server" + "unique-global-server"
			expect(servers.length).toBe(2)

			// Find the shared-server - it should be the project version
			const sharedServer = servers.find((s) => s.name === "shared-server")
			expect(sharedServer).toBeDefined()
			expect(sharedServer!.source).toBe("project")
			expect(sharedServer!.config).toBe('{"source":"project"}')

			// The unique global server should also be present
			const uniqueServer = servers.find((s) => s.name === "unique-global-server")
			expect(uniqueServer).toBeDefined()
		})

		it("should keep global server when no project server with same name exists", () => {
			const mockConnections: McpConnection[] = [
				{
					type: "connected",
					server: {
						name: "global-only-server",
						config: "{}",
						status: "connected",
						disabled: false,
						source: "global",
					},
					client: {} as any,
					transport: {} as any,
				} as ConnectedMcpConnection,
			]

			mcpHub.connections = mockConnections
			const servers = mcpHub.getServers()

			expect(servers.length).toBe(1)
			expect(servers[0].name).toBe("global-only-server")
			expect(servers[0].source).toBe("global")
		})

		it("should prevent calling tools on disabled servers", async () => {
			// Mock fs.readFile to return a disabled server config
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"disabled-server": {
							command: "node",
							args: ["test.js"],
							disabled: true,
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Wait for initialization
			await mcpHub.waitUntilReady()

			// The server should be created as a disconnected connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "disabled-server")
			expect(connection).toBeDefined()
			expect(connection?.type).toBe("disconnected")
			expect(connection?.server.disabled).toBe(true)

			// Try to call tool on disabled server
			await expect(mcpHub.callTool("disabled-server", "some-tool", {})).rejects.toThrow(
				"No connection found for server: disabled-server",
			)
		})

		it("should prevent reading resources from disabled servers", async () => {
			// Mock fs.readFile to return a disabled server config
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"disabled-server": {
							command: "node",
							args: ["test.js"],
							disabled: true,
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Wait for initialization
			await mcpHub.waitUntilReady()

			// The server should be created as a disconnected connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "disabled-server")
			expect(connection).toBeDefined()
			expect(connection?.type).toBe("disconnected")
			expect(connection?.server.disabled).toBe(true)

			// Try to read resource from disabled server
			await expect(mcpHub.readResource("disabled-server", "some/uri")).rejects.toThrow(
				"No connection found for server: disabled-server",
			)
		})
	})

	describe("callTool", () => {
		it("should execute tool successfully", async () => {
			// Mock the connection with a minimal client implementation
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					config: JSON.stringify({}),
					status: "connected" as const,
				},
				client: {
					request: vi.fn().mockResolvedValue({ result: "success" }),
				} as any,
				transport: {
					start: vi.fn(),
					close: vi.fn(),
					stderr: { on: vi.fn() },
				} as any,
			}

			mcpHub.connections = [mockConnection]

			await mcpHub.callTool("test-server", "some-tool", {})

			// Verify the request was made with correct parameters
			expect(mockConnection.client!.request).toHaveBeenCalledWith(
				{
					method: "tools/call",
					params: {
						name: "some-tool",
						arguments: {},
					},
				},
				expect.any(Object),
				expect.objectContaining({ timeout: 60000 }), // Default 60 second timeout
			)
		})

		it("should throw error if server not found", async () => {
			await expect(mcpHub.callTool("non-existent-server", "some-tool", {})).rejects.toThrow(
				"No connection found for server: non-existent-server",
			)
		})

		describe("static OAuth configuration", () => {
			it("accepts static OAuth settings for streamable HTTP", () => {
				const result = ServerConfigSchema.parse({
					type: "streamable-http",
					url: "https://mcp.example.com/mcp",
					oauth: {
						clientId: "registered-client",
						scope: "openid profile offline_access",
						redirectUri: "http://localhost:33418/callback",
						resource: false,
					},
				})

				expect(result.oauth).toEqual({
					clientId: "registered-client",
					scope: "openid profile offline_access",
					redirectUri: "http://localhost:33418/callback",
					resource: false,
				})
			})

			it("accepts a static client without other OAuth settings", () => {
				const result = ServerConfigSchema.parse({
					type: "streamable-http",
					url: "https://mcp.example.com/mcp",
					oauth: { clientId: "registered-client" },
				})

				expect(result.oauth).toEqual({ clientId: "registered-client" })
			})

			it.each([
				{ type: "stdio", command: "test", oauth: { clientId: "client" } },
				{ type: "sse", url: "https://mcp.example.com/sse", oauth: { clientId: "client" } },
				{ type: "streamable-http", url: "https://mcp.example.com/mcp", oauth: { clientId: "" } },
				{
					type: "streamable-http",
					url: "https://mcp.example.com/mcp",
					oauth: { clientId: "client", resource: "invalid" },
				},
				{
					type: "streamable-http",
					url: "https://mcp.example.com/mcp",
					oauth: { clientId: "client", resource: true },
				},
				{ type: "streamable-http", url: "https://mcp.example.com/mcp", oauth: { resource: false } },
			])("rejects invalid OAuth configuration: $type", (config) => {
				expect(() => ServerConfigSchema.parse(config)).toThrow()
			})
		})

		describe("timeout configuration", () => {
			it("should validate timeout values", () => {
				// Test valid timeout values
				const validConfig = {
					type: "stdio",
					command: "test",
					timeout: 60,
				}
				expect(() => ServerConfigSchema.parse(validConfig)).not.toThrow()

				// Test invalid timeout values
				const invalidConfigs = [
					{ type: "stdio", command: "test", timeout: 0 }, // Too low
					{ type: "stdio", command: "test", timeout: 3601 }, // Too high
					{ type: "stdio", command: "test", timeout: -1 }, // Negative
				]

				invalidConfigs.forEach((config) => {
					expect(() => ServerConfigSchema.parse(config)).toThrow()
				})
			})

			it("should use default timeout of 60 seconds if not specified", async () => {
				const mockConnection: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						config: JSON.stringify({ type: "stdio", command: "test" }), // No timeout specified
						status: "connected",
					},
					client: {
						request: vi.fn().mockResolvedValue({ content: [] }),
					} as any,
					transport: {} as any,
				}

				mcpHub.connections = [mockConnection]
				await mcpHub.callTool("test-server", "test-tool")

				expect(mockConnection.client!.request).toHaveBeenCalledWith(
					expect.anything(),
					expect.anything(),
					expect.objectContaining({ timeout: 60000 }), // 60 seconds in milliseconds
				)
			})

			it("should apply configured timeout to tool calls", async () => {
				const mockConnection: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						config: JSON.stringify({ type: "stdio", command: "test", timeout: 120 }), // 2 minutes
						status: "connected",
					},
					client: {
						request: vi.fn().mockResolvedValue({ content: [] }),
					} as any,
					transport: {} as any,
				}

				mcpHub.connections = [mockConnection]
				await mcpHub.callTool("test-server", "test-tool")

				expect(mockConnection.client!.request).toHaveBeenCalledWith(
					expect.anything(),
					expect.anything(),
					expect.objectContaining({ timeout: 120000 }), // 120 seconds in milliseconds
				)
			})
		})

		describe("updateServerTimeout", () => {
			it("should update server timeout in settings file", async () => {
				const mockConfig = {
					mcpServers: {
						"test-server": {
							type: "stdio",
							command: "node",
							args: ["test.js"],
							timeout: 60,
						},
					},
				}

				// Mock reading initial config
				vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

				// Set up mock connection
				const mockConnection: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						type: "stdio",
						command: "node",
						args: ["test.js"],
						timeout: 60,
						source: "global",
					} as any,
					client: {} as any,
					transport: {} as any,
				}
				mcpHub.connections = [mockConnection]

				await mcpHub.updateServerTimeout("test-server", 120)

				// Verify the config was updated correctly
				// Find the write call with the normalized path
				const normalizedSettingsPath = "/mock/settings/path/cline_mcp_settings.json"
				const writeCalls = vi.mocked(fs.writeFile).mock.calls

				// Find the write call with the normalized path
				const writeCall = writeCalls.find((call: any) => call[0] === normalizedSettingsPath)
				const callToUse = writeCall || writeCalls[0]

				const writtenConfig = JSON.parse(callToUse[1] as string)
				expect(writtenConfig.mcpServers["test-server"].timeout).toBe(120)
			})

			it("should fallback to default timeout when config has invalid timeout", async () => {
				const mockConfig = {
					mcpServers: {
						"test-server": {
							type: "stdio",
							command: "node",
							args: ["test.js"],
							timeout: 60,
						},
					},
				}

				// Mock initial read
				vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

				// Set up mock connection before updating
				const mockConnectionInitial: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						type: "stdio",
						command: "node",
						args: ["test.js"],
						timeout: 60,
						source: "global",
					} as any,
					client: {
						request: vi.fn().mockResolvedValue({ content: [] }),
					} as any,
					transport: {} as any,
				}
				mcpHub.connections = [mockConnectionInitial]

				// Update with invalid timeout
				await mcpHub.updateServerTimeout("test-server", 3601)

				// Config is written
				expect(fs.writeFile).toHaveBeenCalled()

				// Setup connection with invalid timeout
				const mockConnectionInvalid: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						config: JSON.stringify({
							type: "stdio",
							command: "node",
							args: ["test.js"],
							timeout: 3601, // Invalid timeout
						}),
						status: "connected",
					},
					client: {
						request: vi.fn().mockResolvedValue({ content: [] }),
					} as any,
					transport: {} as any,
				}

				mcpHub.connections = [mockConnectionInvalid]

				// Call tool - should use default timeout
				await mcpHub.callTool("test-server", "test-tool")

				// Verify default timeout was used
				expect(mockConnectionInvalid.client!.request).toHaveBeenCalledWith(
					expect.anything(),
					expect.anything(),
					expect.objectContaining({ timeout: 60000 }), // Default 60 seconds
				)
			})

			it("should accept valid timeout values", async () => {
				const mockConfig = {
					mcpServers: {
						"test-server": {
							type: "stdio",
							command: "node",
							args: ["test.js"],
							timeout: 60,
						},
					},
				}

				vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

				// Set up mock connection
				const mockConnection: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						type: "stdio",
						command: "node",
						args: ["test.js"],
						timeout: 60,
						source: "global",
					} as any,
					client: {} as any,
					transport: {} as any,
				}
				mcpHub.connections = [mockConnection]

				// Test valid timeout values
				const validTimeouts = [1, 60, 3600]
				for (const timeout of validTimeouts) {
					await mcpHub.updateServerTimeout("test-server", timeout)
					expect(fs.writeFile).toHaveBeenCalled()
					vi.clearAllMocks() // Reset for next iteration
					;(fs.readFile as any).mockResolvedValueOnce(JSON.stringify(mockConfig))
				}
			})

			it("should notify webview after updating timeout", async () => {
				const mockConfig = {
					mcpServers: {
						"test-server": {
							type: "stdio",
							command: "node",
							args: ["test.js"],
							timeout: 60,
						},
					},
				}

				vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

				// Set up mock connection
				const mockConnection: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						type: "stdio",
						command: "node",
						args: ["test.js"],
						timeout: 60,
						source: "global",
					} as any,
					client: {} as any,
					transport: {} as any,
				}
				mcpHub.connections = [mockConnection]

				await mcpHub.updateServerTimeout("test-server", 120)

				expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "mcpServers",
					}),
				)
			})
		})
	})

	describe("MCP global enable/disable", () => {
		beforeEach(() => {
			// Clear all mocks before each test
			vi.clearAllMocks()
		})

		it("should disconnect all servers when MCP is toggled from enabled to disabled", async () => {
			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(function () {
				return mockTransport
			})

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			const mockClient = {
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
			}

			Client.mockImplementation(function () {
				return mockClient
			})

			// Start with MCP enabled
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: true })

			// Mock the config file read
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"toggle-test-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			// Create McpHub and let it initialize with MCP enabled
			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await mcpHub.waitUntilReady()

			// Verify server is connected
			const connectedServer = mcpHub.connections.find((conn) => conn.server.name === "toggle-test-server")
			expect(connectedServer).toBeDefined()
			expect(connectedServer!.server.status).toBe("connected")
			expect(connectedServer!.client).toBeDefined()
			expect(connectedServer!.transport).toBeDefined()

			// Now simulate toggling MCP to disabled
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: false })

			// Manually trigger what would happen when MCP is disabled
			// (normally this would be triggered by the webview message handler)
			const existingConnections = [...mcpHub.connections]
			for (const conn of existingConnections) {
				await mcpHub.deleteConnection(conn.server.name, conn.server.source)
			}
			await mcpHub.refreshAllConnections()

			// Verify server is now tracked but disconnected
			const disconnectedServer = mcpHub.connections.find((conn) => conn.server.name === "toggle-test-server")
			expect(disconnectedServer).toBeDefined()
			expect(disconnectedServer!.server.status).toBe("disconnected")
			expect(disconnectedServer!.client).toBeNull()
			expect(disconnectedServer!.transport).toBeNull()

			// Verify close was called on the original client and transport
			expect(mockClient.close).toHaveBeenCalled()
			expect(mockTransport.close).toHaveBeenCalled()
		})

		it("should not connect to servers when MCP is globally disabled", async () => {
			// Mock provider with mcpEnabled: false
			const disabledMockProvider = {
				ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				postMessageToWebview: vi.fn(),
				getState: vi.fn().mockResolvedValue({ mcpEnabled: false }),
				context: mockProvider.context,
			}

			// Mock the config file read with a different server name to avoid conflicts
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"disabled-test-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			// Create a new McpHub instance with disabled MCP
			const mcpHub = new McpHub(disabledMockProvider as unknown as ClineProvider)

			// Wait for initialization
			await mcpHub.waitUntilReady()

			// Find the disabled-test-server
			const disabledServer = mcpHub.connections.find((conn) => conn.server.name === "disabled-test-server")

			// Verify that the server is tracked but not connected
			expect(disabledServer).toBeDefined()
			expect(disabledServer!.server.status).toBe("disconnected")
			expect(disabledServer!.client).toBeNull()
			expect(disabledServer!.transport).toBeNull()
		})

		it("should connect to servers when MCP is globally enabled", async () => {
			// Clear all mocks
			vi.clearAllMocks()

			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(function () {
				return mockTransport
			})

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			Client.mockImplementation(function () {
				return {
					connect: vi.fn().mockResolvedValue(undefined),
					close: vi.fn().mockResolvedValue(undefined),
					getInstructions: vi.fn().mockReturnValue("test instructions"),
					request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				}
			})

			// Mock provider with mcpEnabled: true
			const enabledMockProvider = {
				ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				postMessageToWebview: vi.fn(),
				getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
				context: mockProvider.context,
			}

			// Mock the config file read with a different server name
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"enabled-test-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			// Create a new McpHub instance with enabled MCP
			const mcpHub = new McpHub(enabledMockProvider as unknown as ClineProvider)

			// Wait for initialization
			await mcpHub.waitUntilReady()

			// Find the enabled-test-server
			const enabledServer = mcpHub.connections.find((conn) => conn.server.name === "enabled-test-server")

			// Verify that the server is connected
			expect(enabledServer).toBeDefined()
			expect(enabledServer!.server.status).toBe("connected")
			expect(enabledServer!.client).toBeDefined()
			expect(enabledServer!.transport).toBeDefined()

			// Verify StdioClientTransport was called
			expect(StdioClientTransport).toHaveBeenCalled()
		})

		it("should handle refreshAllConnections when MCP is disabled", async () => {
			// Mock provider with mcpEnabled: false
			const disabledMockProvider = {
				ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				postMessageToWebview: vi.fn(),
				getState: vi.fn().mockResolvedValue({ mcpEnabled: false }),
				context: mockProvider.context,
			}

			// Mock the config file read
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"refresh-test-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			// Create McpHub with disabled MCP
			const mcpHub = new McpHub(disabledMockProvider as unknown as ClineProvider)
			await mcpHub.waitUntilReady()

			// Clear previous calls
			vi.clearAllMocks()

			// Call refreshAllConnections
			await mcpHub.refreshAllConnections()

			// Verify that servers are tracked but not connected
			const server = mcpHub.connections.find((conn) => conn.server.name === "refresh-test-server")
			expect(server).toBeDefined()
			expect(server!.server.status).toBe("disconnected")
			expect(server!.client).toBeNull()
			expect(server!.transport).toBeNull()

			// Verify postMessageToWebview was called to update the UI
			expect(disabledMockProvider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "mcpServers",
				}),
			)
		})

		it("should skip restarting connection when MCP is disabled", async () => {
			// Mock provider with mcpEnabled: false
			const disabledMockProvider = {
				ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				postMessageToWebview: vi.fn(),
				getState: vi.fn().mockResolvedValue({ mcpEnabled: false }),
				context: mockProvider.context,
			}

			// Mock the config file read
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"restart-test-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			// Create McpHub with disabled MCP
			const mcpHub = new McpHub(disabledMockProvider as unknown as ClineProvider)
			await mcpHub.waitUntilReady()

			// Set isConnecting to false to ensure it's properly reset
			mcpHub.isConnecting = false

			// Try to restart a connection
			await mcpHub.restartConnection("restart-test-server")

			// Verify that isConnecting was reset to false
			expect(mcpHub.isConnecting).toBe(false)

			// Verify that the server remains disconnected
			const server = mcpHub.connections.find((conn) => conn.server.name === "restart-test-server")
			expect(server).toBeDefined()
			expect(server!.server.status).toBe("disconnected")
			expect(server!.client).toBeNull()
			expect(server!.transport).toBeNull()
		})
	})

	describe("Windows command wrapping", () => {
		let StdioClientTransport: ReturnType<typeof vi.fn>
		let Client: ReturnType<typeof vi.fn>

		beforeEach(async () => {
			// Reset mocks
			vi.clearAllMocks()

			// Get references to the mocked constructors
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>
			Client = clientModule.Client as ReturnType<typeof vi.fn>

			// Mock Windows platform
			Object.defineProperty(process, "platform", {
				value: "win32",
				writable: true,
				enumerable: true,
				configurable: true,
			})
		})

		it("should wrap commands with cmd.exe on Windows", async () => {
			// Mock StdioClientTransport
			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(function (config: any) {
				// Verify that cmd.exe wrapping is applied
				expect(config.command).toBe("cmd.exe")
				expect(config.args).toEqual([
					"/c",
					"npx",
					"-y",
					"@modelcontextprotocol/server-filesystem",
					"/test/path",
				])
				return mockTransport
			})

			// Mock Client
			Client.mockImplementation(function () {
				return {
					connect: vi.fn().mockResolvedValue(undefined),
					close: vi.fn().mockResolvedValue(undefined),
					getInstructions: vi.fn().mockReturnValue("test instructions"),
					request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				}
			})

			// Mock the config file read
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"test-npx-server": {
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-filesystem", "/test/path"],
						},
					},
				}),
			)

			// Create a new McpHub instance
			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Wait for initialization
			await mcpHub.waitUntilReady()

			// Verify StdioClientTransport was called with wrapped command
			expect(StdioClientTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "cmd.exe",
					args: ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/test/path"],
				}),
			)
		})

		it("should not wrap commands on non-Windows platforms", async () => {
			// Mock non-Windows platform
			Object.defineProperty(process, "platform", {
				value: "darwin",
				writable: true,
				enumerable: true,
				configurable: true,
			})

			// Mock StdioClientTransport
			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(function (config: any) {
				// Verify that no cmd.exe wrapping is applied
				expect(config.command).toBe("npx")
				expect(config.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/test/path"])
				return mockTransport
			})

			// Mock Client
			Client.mockImplementation(function () {
				return {
					connect: vi.fn().mockResolvedValue(undefined),
					close: vi.fn().mockResolvedValue(undefined),
					getInstructions: vi.fn().mockReturnValue("test instructions"),
					request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				}
			})

			// Mock the config file read
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"test-npx-server": {
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-filesystem", "/test/path"],
						},
					},
				}),
			)

			// Create a new McpHub instance
			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Wait for initialization
			await mcpHub.waitUntilReady()

			// Verify StdioClientTransport was called without wrapping
			expect(StdioClientTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-filesystem", "/test/path"],
				}),
			)
		})

		it("should not double-wrap commands that are already cmd.exe", async () => {
			// Mock Windows platform
			Object.defineProperty(process, "platform", {
				value: "win32",
				writable: true,
				enumerable: true,
				configurable: true,
			})

			// Mock StdioClientTransport
			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(function (config: any) {
				// Verify that cmd.exe is not double-wrapped
				expect(config.command).toBe("cmd.exe")
				expect(config.args).toEqual(["/c", "echo", "test"])
				return mockTransport
			})

			// Mock Client
			Client.mockImplementation(function () {
				return {
					connect: vi.fn().mockResolvedValue(undefined),
					close: vi.fn().mockResolvedValue(undefined),
					getInstructions: vi.fn().mockReturnValue("test instructions"),
					request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				}
			})

			// Mock the config file read with cmd.exe already as command
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"test-cmd-server": {
							command: "cmd.exe",
							args: ["/c", "echo", "test"],
						},
					},
				}),
			)

			// Create a new McpHub instance
			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Wait for initialization
			await mcpHub.waitUntilReady()

			// Verify StdioClientTransport was called without double-wrapping
			expect(StdioClientTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "cmd.exe",
					args: ["/c", "echo", "test"],
				}),
			)
		})

		it("should handle npx.ps1 scenario from node version managers", async () => {
			// Mock Windows platform
			Object.defineProperty(process, "platform", {
				value: "win32",
				writable: true,
				enumerable: true,
				configurable: true,
			})

			// Mock StdioClientTransport to simulate the ENOENT error without wrapping
			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			let callCount = 0
			StdioClientTransport.mockImplementation(function (config: any) {
				callCount++
				// First call would fail with ENOENT if not wrapped
				// Second call should be wrapped with cmd.exe
				if (callCount === 1) {
					// This simulates what would happen without wrapping
					expect(config.command).toBe("cmd.exe")
					expect(config.args[0]).toBe("/c")
					expect(config.args[1]).toBe("npx")
				}
				return mockTransport
			})

			// Mock Client
			Client.mockImplementation(function () {
				return {
					connect: vi.fn().mockResolvedValue(undefined),
					close: vi.fn().mockResolvedValue(undefined),
					getInstructions: vi.fn().mockReturnValue("test instructions"),
					request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				}
			})

			// Mock the config file read - simulating fnm/nvm-windows scenario
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"test-fnm-npx-server": {
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-example"],
							env: {
								// Simulate fnm environment
								FNM_DIR: "C:\\Users\\test\\.fnm",
								FNM_NODE_DIST_MIRROR: "https://nodejs.org/dist",
								FNM_ARCH: "x64",
							},
						},
					},
				}),
			)

			// Create a new McpHub instance
			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Wait for initialization
			await mcpHub.waitUntilReady()

			// Verify that the command was wrapped with cmd.exe
			expect(StdioClientTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "cmd.exe",
					args: ["/c", "npx", "-y", "@modelcontextprotocol/server-example"],
					env: expect.objectContaining({
						FNM_DIR: "C:\\Users\\test\\.fnm",
						FNM_NODE_DIST_MIRROR: "https://nodejs.org/dist",
						FNM_ARCH: "x64",
					}),
				}),
			)
		})

		it("should handle case-insensitive cmd command check", async () => {
			// Mock Windows platform
			Object.defineProperty(process, "platform", {
				value: "win32",
				writable: true,
				enumerable: true,
				configurable: true,
			})

			// Mock StdioClientTransport
			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(function (config: any) {
				// Verify that CMD (uppercase) is not double-wrapped
				expect(config.command).toBe("CMD")
				expect(config.args).toEqual(["/c", "echo", "test"])
				return mockTransport
			})

			// Mock Client
			Client.mockImplementation(function () {
				return {
					connect: vi.fn().mockResolvedValue(undefined),
					close: vi.fn().mockResolvedValue(undefined),
					getInstructions: vi.fn().mockReturnValue("test instructions"),
					request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				}
			})

			// Mock the config file read with CMD (uppercase) as command
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"test-cmd-uppercase-server": {
							command: "CMD",
							args: ["/c", "echo", "test"],
						},
					},
				}),
			)

			// Create a new McpHub instance
			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Wait for initialization
			await mcpHub.waitUntilReady()

			// Verify StdioClientTransport was called without double-wrapping
			expect(StdioClientTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "CMD",
					args: ["/c", "echo", "test"],
				}),
			)
		})
	})

	describe("_initiateOAuthFlow with persistent notification", () => {
		const serverName = "oauth-server"
		const serverUrl = "https://example.com/mcp"
		const source = "global" as const
		const config = ServerConfigSchema.parse({ type: "streamable-http", url: serverUrl })

		let mockAuthProvider: any
		let mockTransport: any
		let mockConnection: any
		let mockSecretStorage: any
		let vsc: any

		beforeEach(async () => {
			vi.clearAllMocks()
			vsc = await import("vscode")

			mockAuthProvider = {
				openBrowser: vi.fn().mockResolvedValue(undefined),
				waitForAuthCode: vi.fn().mockResolvedValue("auth-code-123"),
				exchangeCodeForTokens: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
			}

			mockTransport = { close: vi.fn().mockResolvedValue(undefined) }

			mockConnection = {
				client: { close: vi.fn().mockResolvedValue(undefined) },
				transport: mockTransport,
				authProvider: mockAuthProvider,
				type: "connected",
				server: {
					source,
					status: "connecting",
					config: JSON.stringify(config),
					name: serverName,
				},
			}

			mockSecretStorage = {
				getOAuthData: vi.fn().mockResolvedValue(null),
				onDidChange: vi.fn().mockImplementation(() => vi.fn()),
			}
			;(mcpHub as any).secretStorage = mockSecretStorage

			mcpHub.connections = [mockConnection]
			vi.spyOn(mcpHub, "deleteConnection")
			vi.spyOn(mcpHub as any, "connectToServer").mockImplementation(async () => {
				mcpHub.connections = [{ ...mockConnection, server: { ...mockConnection.server, status: "connected" } }]
			})
			vi.spyOn(mcpHub as any, "notifyWebviewOfServerChanges").mockResolvedValue(undefined)
			vi.spyOn(mcpHub as any, "findConnection")
			vi.spyOn(mcpHub as any, "validateServerConfig").mockReturnValue(config)
			vi.spyOn(mcpHub as any, "appendErrorMessage").mockReturnValue(undefined)
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("should use withProgress for persistent notification", async () => {
			vsc.window.showInformationMessage.mockResolvedValueOnce(t("mcp:oauth.flow.authenticateButton") as any)
			vi.spyOn(mcpHub as any, "_completeOAuthFlow").mockResolvedValue(undefined)

			await (mcpHub as any)._initiateOAuthFlow(
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			expect(vsc.window.withProgress).toHaveBeenCalledWith(
				expect.objectContaining({
					location: vsc.ProgressLocation.Notification,
					cancellable: true,
				}),
				expect.any(Function),
			)
		})

		it("should update progress bar hint when toast is dismissed without clicking Authenticate", async () => {
			let capturedProgress: any
			vsc.window.withProgress.mockImplementationOnce((_options: any, task: any) => {
				capturedProgress = { report: vi.fn() }
				const cancellationToken = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
					_fire: vi.fn(),
				}
				return task(capturedProgress, cancellationToken)
			})

			vsc.window.showInformationMessage.mockResolvedValueOnce(undefined as any)
			vi.useFakeTimers()

			const flowPromise = (mcpHub as any)._initiateOAuthFlow(
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS)
			await flowPromise

			expect(vsc.window.showInformationMessage).toHaveBeenCalledTimes(1)
			expect(capturedProgress.report).toHaveBeenCalledWith({
				message: t("mcp:oauth.flow.dismissedHint"),
			})
		})

		it("should resolve when cross-window tokens arrive", async () => {
			vsc.window.showInformationMessage.mockImplementation(() => {
				return new Promise(() => {})
			})

			mockSecretStorage.onDidChange.mockImplementation((_key: string, cb: () => void) => {
				queueMicrotask(() => {
					mockSecretStorage.getOAuthData.mockResolvedValue({
						expires_at: Date.now() + 10 * 60 * 1000,
					})
					cb()
				})
				return vi.fn()
			})

			await (mcpHub as any)._initiateOAuthFlow(
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			expect(mockAuthProvider.close).toHaveBeenCalled()
			expect((mcpHub as any).deleteConnection).toHaveBeenCalledWith(serverName, source, expect.any(McpOAuthFlow))
			expect((mcpHub as any).connectToServer).toHaveBeenCalled()
		})

		it("should skip flow when valid tokens already exist", async () => {
			mockSecretStorage.getOAuthData.mockResolvedValue({
				expires_at: Date.now() + 10 * 60 * 1000,
			})

			await (mcpHub as any)._initiateOAuthFlow(
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			expect(vsc.window.withProgress).not.toHaveBeenCalled()
			expect(mockAuthProvider.close).toHaveBeenCalled()
			expect((mcpHub as any).deleteConnection).toHaveBeenCalledWith(serverName, source, expect.any(McpOAuthFlow))
			expect((mcpHub as any).connectToServer).toHaveBeenCalled()
		})

		it("should disconnect and flag error when user cancels the OAuth flow", async () => {
			// Override withProgress for this test to capture the cancellation token
			let capturedCancellationToken: any
			vsc.window.withProgress.mockImplementationOnce((_options: any, task: any) => {
				const progress = { report: vi.fn() }
				const tokenListeners: Array<() => void> = []
				capturedCancellationToken = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn((cb: () => void) => {
						tokenListeners.push(cb)
						return { dispose: vi.fn() }
					}),
					_fire: () => tokenListeners.forEach((cb) => cb()),
				}
				return task(progress, capturedCancellationToken)
			})

			const flowPromise = (mcpHub as any)._initiateOAuthFlow(
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			// Wait for withProgress to be invoked: getOAuthData must resolve first,
			// then the continuation calls withProgress synchronously, setting capturedCancellationToken.
			await vi.waitFor(() => expect(capturedCancellationToken).toBeDefined())
			capturedCancellationToken._fire()

			await flowPromise

			expect(mockConnection.server.status).toBe("disconnected")
			expect((mcpHub as any).appendErrorMessage).toHaveBeenCalled()
			expect(mockAuthProvider.close).toHaveBeenCalled()
		})

		it("should handle a token that is already cancelled at listener registration time", async () => {
			// Regression: VS Code's CancellationToken.onCancellationRequested() fires the
			// callback synchronously inside the registration call when the token is already
			// cancelled. If cleanup() captures `const cancellationDisposable = onCancellationRequested(...)`
			// from outer scope, the callback runs while that binding is still in the temporal
			// dead zone and accessing it throws ReferenceError. cleanup() must therefore
			// receive the disposable as a parameter and the cancellation callback must invoke
			// cleanup() without it.
			vsc.window.withProgress.mockImplementationOnce((_options: any, task: any) => {
				const progress = { report: vi.fn() }
				const cancellationToken = {
					isCancellationRequested: true,
					// Fire synchronously during registration — simulates an already-cancelled
					// token in real VS Code.
					onCancellationRequested: vi.fn((cb: () => void) => {
						cb()
						return { dispose: vi.fn() }
					}),
				}
				return task(progress, cancellationToken)
			})

			await expect(
				(mcpHub as any)._initiateOAuthFlow(
					serverName,
					source,
					config,
					mockAuthProvider,
					mockTransport,
					mockConnection,
				),
			).resolves.toBe("cancelled")

			expect(mockConnection.server.status).toBe("disconnected")
			expect((mcpHub as any).appendErrorMessage).toHaveBeenCalled()
			expect(mockAuthProvider.close).toHaveBeenCalled()

			// A listener returned after synchronous cancellation must be disposed immediately.
			// If the registration happens AFTER the callback is installed, the entry
			// is added after disposal and remains orphaned in the map. Registering the
			// watcher BEFORE installing the callback ensures cleanup() finds and
			// deletes it cleanly.
			expect((mcpHub as any).oauthFlows.has(mockConnection)).toBe(false)
		})

		it("should disconnect and flag error when OAuth flow times out", async () => {
			vi.useFakeTimers()
			vsc.window.showInformationMessage.mockImplementation(() => {
				return new Promise(() => {})
			})

			const flowPromise = (mcpHub as any)._initiateOAuthFlow(
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS)
			await flowPromise

			expect(mockConnection.server.status).toBe("disconnected")
			expect((mcpHub as any).appendErrorMessage).toHaveBeenCalled()
			expect(mockAuthProvider.close).toHaveBeenCalled()
		})

		it("clears the approval timer when Authenticate is clicked late", async () => {
			vi.useFakeTimers()
			let approve!: (choice: string) => void
			let code!: (value: string) => void
			vsc.window.showInformationMessage.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						approve = resolve
					}),
			)
			mockAuthProvider.waitForAuthCode.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						code = resolve
					}),
			)
			const result = mcpHub["_initiateOAuthFlow"](
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)
			try {
				await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS - 1000)
				approve(t("mcp:oauth.flow.authenticateButton"))
				await vi.advanceTimersByTimeAsync(0)
				await vi.advanceTimersByTimeAsync(1001)
				expect(mcpHub["oauthFlows"].get(mockConnection)?.phase).toBe("authenticating")
				expect(mockConnection.server.status).toBe("connecting")
			} finally {
				code("late-code")
				await result
			}
		})

		it("should dispose the cancellation listener when the OAuth flow times out", async () => {
			vi.useFakeTimers()
			const mockDispose = vi.fn()
			vsc.window.withProgress.mockImplementationOnce((_options: any, task: any) => {
				const progress = { report: vi.fn() }
				const cancellationToken = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn(() => ({ dispose: mockDispose })),
				}
				return task(progress, cancellationToken)
			})
			vsc.window.showInformationMessage.mockImplementation(() => new Promise(() => {}))

			const flowPromise = (mcpHub as any)._initiateOAuthFlow(
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS)
			await flowPromise

			// cleanup(cancellationDisposable) inside the timeout handler must dispose the listener
			expect(mockDispose).toHaveBeenCalled()
		})

		it("should resolve without calling _completeOAuthFlow when tokens exist at click time", async () => {
			// Tokens are present when Authenticate is clicked (click-time guard in the loop).
			// First call (pre-withProgress early-return check) returns null so withProgress runs.
			// Second call (after click) returns valid tokens, exercising the click-time guard.
			vsc.window.showInformationMessage.mockResolvedValueOnce(t("mcp:oauth.flow.authenticateButton") as any)
			mockSecretStorage.getOAuthData
				.mockResolvedValueOnce(null) // pre-check: no tokens yet, flow proceeds to withProgress
				.mockResolvedValue({ expires_at: Date.now() + 10 * 60 * 1000 }) // at click time

			const completeOAuthSpy = vi.spyOn(mcpHub as any, "_completeOAuthFlow")

			await (mcpHub as any)._initiateOAuthFlow(
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			expect(completeOAuthSpy).not.toHaveBeenCalled()
			expect(mockAuthProvider.close).toHaveBeenCalled()
			expect((mcpHub as any).deleteConnection).toHaveBeenCalledWith(serverName, source, expect.any(McpOAuthFlow))
			expect((mcpHub as any).connectToServer).toHaveBeenCalled()
		})

		it("should resolve cleanly even when _completeOAuthFlow throws", async () => {
			vsc.window.showInformationMessage.mockResolvedValueOnce(t("mcp:oauth.flow.authenticateButton") as any)
			vi.spyOn(mcpHub as any, "_completeOAuthFlow").mockRejectedValue(new Error("network failure"))

			await expect(
				(mcpHub as any)._initiateOAuthFlow(
					serverName,
					source,
					config,
					mockAuthProvider,
					mockTransport,
					mockConnection,
				),
			).resolves.toBe("failed")
		})

		it("should record the callback error and disconnect when waitForAuthCode rejects", async () => {
			vsc.window.showInformationMessage.mockResolvedValueOnce(t("mcp:oauth.flow.authenticateButton"))
			// The provider reports a callback listener failure, such as a timeout before the user authenticated.
			mockAuthProvider.waitForAuthCode.mockRejectedValueOnce(new Error("Callback timeout"))

			await mcpHub["_initiateOAuthFlow"](
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			expect(mockAuthProvider.openBrowser).toHaveBeenCalledTimes(1)
			expect(mockAuthProvider.exchangeCodeForTokens).not.toHaveBeenCalled()
			expect(mockAuthProvider.close).toHaveBeenCalled()
			expect(mockConnection.server.status).toBe("disconnected")
			expect(mcpHub["appendErrorMessage"]).toHaveBeenCalledTimes(1)
			expect(mcpHub["appendErrorMessage"]).toHaveBeenCalledWith(mockConnection, "Callback timeout")
			expect(mcpHub["connectToServer"]).not.toHaveBeenCalled()
		})

		it("should disconnect and flag error when Cancel is pressed after Authenticate is clicked", async () => {
			// Simulate: user clicks Authenticate in the toast, then cancels via the progress bar
			// while waitForAuthCode is still pending.
			let capturedCancellationToken: any
			vsc.window.withProgress.mockImplementationOnce((_options: any, task: any) => {
				const progress = { report: vi.fn() }
				const tokenListeners: Array<() => void> = []
				capturedCancellationToken = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn((cb: () => void) => {
						tokenListeners.push(cb)
						return { dispose: vi.fn() }
					}),
					_fire: () => {
						capturedCancellationToken.isCancellationRequested = true
						tokenListeners.forEach((cb) => cb())
					},
				}
				return task(progress, capturedCancellationToken)
			})

			// Toast resolves immediately with Authenticate clicked
			vsc.window.showInformationMessage.mockResolvedValueOnce(t("mcp:oauth.flow.authenticateButton") as any)
			mockSecretStorage.getOAuthData.mockResolvedValue(null) // no pre-existing tokens

			// waitForAuthCode never resolves — simulates browser waiting for the callback
			mockAuthProvider.waitForAuthCode.mockReturnValue(new Promise(() => {}))

			const flowPromise = (mcpHub as any)._initiateOAuthFlow(
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			// Let the flow advance: getOAuthData resolves, withProgress runs,
			// showInformationMessage resolves (Authenticate clicked), getOAuthData
			// re-checked (null), cleanup() called, _completeOAuthFlow entered,
			// openBrowser() called, then waitForAuthCode blocks.
			await new Promise((r) => setTimeout(r, 0))

			// Fire Cancel on the progress bar while waitForAuthCode is blocked
			capturedCancellationToken._fire()

			await flowPromise

			expect(mockConnection.server.status).toBe("disconnected")
			expect((mcpHub as any).appendErrorMessage).toHaveBeenCalledWith(
				mockConnection,
				t("mcp:oauth.flow.cancelled"),
			)
			expect(mockAuthProvider.close).toHaveBeenCalled()
		})

		it("should close the provider when the hub is disposed during the initial token read", async () => {
			let resolveTokenRead!: (value: null) => void
			mockSecretStorage.getOAuthData.mockReturnValueOnce(
				new Promise<null>((resolve) => {
					resolveTokenRead = resolve
				}),
			)

			const flowPromise = mcpHub["_initiateOAuthFlow"](
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)
			mcpHub["isDisposed"] = true
			resolveTokenRead(null)
			await flowPromise

			expect(mockAuthProvider.close).toHaveBeenCalledTimes(1)
			expect(vsc.window.withProgress).not.toHaveBeenCalled()
		})

		it("should not reconnect when hub is disposed while cross-window tokens arrive", async () => {
			vi.useFakeTimers()
			vsc.window.showInformationMessage.mockImplementation(() => {
				return new Promise(() => {})
			})

			mockSecretStorage.onDidChange.mockImplementation((_key: string, cb: () => void) => {
				queueMicrotask(() => {
					// Dispose the hub before the token callback runs
					;(mcpHub as any).isDisposed = true
					mockSecretStorage.getOAuthData.mockResolvedValue({
						expires_at: Date.now() + 10 * 60 * 1000,
					})
					cb()
				})
				return vi.fn()
			})

			const flowPromise = (mcpHub as any)._initiateOAuthFlow(
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			// Timeout to unblock the flow (watcher bailed due to isDisposed)
			await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS)
			await flowPromise

			expect((mcpHub as any).connectToServer).not.toHaveBeenCalled()
		})

		it("should not reconnect when cross-window watcher fires but token is missing or expired", async () => {
			vi.useFakeTimers()
			vsc.window.showInformationMessage.mockImplementation(() => {
				return new Promise(() => {})
			})

			// onDidChange fires immediately (simulates a storage event during the read gap)
			// but getOAuthData returns undefined — no valid token written.
			mockSecretStorage.onDidChange.mockImplementation((_key: string, cb: () => void) => {
				cb() // fires synchronously — sets crossWindowTokenWritten flag
				return vi.fn()
			})
			mockSecretStorage.getOAuthData.mockResolvedValue(undefined)

			const flowPromise = (mcpHub as any)._initiateOAuthFlow(
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			// Advance past the timeout so the flow can settle
			await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS)
			await flowPromise

			// Should NOT have tried to reconnect — the watcher fired but no valid token exists
			expect((mcpHub as any).connectToServer).not.toHaveBeenCalledWith(serverName, expect.anything(), source)
		})

		it("should reconnect when cross-window token is written while getOAuthData is in-flight", async () => {
			// This covers the race: onDidChange fires BEFORE getOAuthData resolves.
			// The flag causes a second read which finds the now-valid token.
			let resolveGetOAuthData!: (value: any) => void
			mockSecretStorage.getOAuthData
				// First call (during the race window) — delayed, returns undefined
				.mockImplementationOnce(
					() =>
						new Promise((r) => {
							resolveGetOAuthData = r
						}),
				)
				// Second call (after watcher fires) — valid token available
				.mockResolvedValueOnce({ expires_at: Date.now() + 10 * 60 * 1000 })

			// Watcher fires synchronously before getOAuthData resolves
			mockSecretStorage.onDidChange.mockImplementation((_key: string, cb: () => void) => {
				cb()
				return vi.fn()
			})

			const flowPromise = (mcpHub as any)._initiateOAuthFlow(
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)

			// Now let the first getOAuthData resolve with undefined
			resolveGetOAuthData(undefined)
			await flowPromise

			expect(mockAuthProvider.close).toHaveBeenCalled()
			expect((mcpHub as any).deleteConnection).toHaveBeenCalledWith(serverName, source, expect.any(McpOAuthFlow))
			expect((mcpHub as any).connectToServer).toHaveBeenCalled()
			expect(vsc.window.withProgress).not.toHaveBeenCalled()
		})

		it("joins repeated OAuth requests on the same connection", async () => {
			vi.useFakeTimers()
			vsc.window.showInformationMessage.mockImplementation(() => new Promise(() => {}))
			const first = mcpHub["_initiateOAuthFlow"](
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)
			await vi.advanceTimersByTimeAsync(0)
			const flow = mcpHub["oauthFlows"].get(mockConnection)
			const subscriptions = mockSecretStorage.onDidChange.mock.calls.length
			const second = mcpHub["_initiateOAuthFlow"](
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)
			await vi.advanceTimersByTimeAsync(0)
			expect(mcpHub["oauthFlows"].get(mockConnection)).toBe(flow)
			expect(mockSecretStorage.onDidChange).toHaveBeenCalledTimes(subscriptions)
			await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS)
			await Promise.all([first, second])
			expect(mcpHub["oauthFlows"].size).toBe(0)
		})

		it("keeps a replacement flow when an old toast resolves", async () => {
			vi.useFakeTimers()
			let resolveFirstToast!: (choice?: string) => void
			vsc.window.showInformationMessage.mockImplementationOnce(
				() =>
					new Promise<string | undefined>((resolve) => {
						resolveFirstToast = resolve
					}),
			)
			vsc.window.showInformationMessage.mockImplementation(() => new Promise(() => {}))
			const first = mcpHub["_initiateOAuthFlow"](
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				mockConnection,
			)
			await vi.advanceTimersByTimeAsync(0)
			const replacement = { ...mockConnection, server: { ...mockConnection.server } }
			vi.mocked(mcpHub["findConnection"]).mockReturnValue(replacement)
			const second = mcpHub["_initiateOAuthFlow"](
				serverName,
				source,
				config,
				mockAuthProvider,
				mockTransport,
				replacement,
			)
			await vi.advanceTimersByTimeAsync(0)
			const currentFlow = mcpHub["oauthFlows"].get(replacement)
			resolveFirstToast(t("mcp:oauth.flow.authenticateButton"))
			await vi.advanceTimersByTimeAsync(0)
			await first
			expect(currentFlow?.phase).toBe("waiting")
			expect(mcpHub["oauthFlows"].get(replacement)).toBe(currentFlow)
			expect(mcpHub["connectToServer"]).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS)
			await second
			expect(mcpHub["oauthFlows"].size).toBe(0)
		})

		it("ends the flow and surfaces the error when the token-watcher reconnect throws", async () => {
			vi.useFakeTimers()
			const hub = mcpHub as unknown as {
				oauthFlows: Map<string, unknown>
				_initiateOAuthFlow: (
					name: string,
					source: "global" | "project",
					config: unknown,
					authProvider: unknown,
					transport: unknown,
					connection: unknown,
				) => Promise<void>
				appendErrorMessage: Mock & ((connection: unknown, message: string) => void)
				connectToServer: Mock & ((...args: unknown[]) => Promise<void>)
			}
			const closeMock = vi.fn().mockResolvedValue(undefined)
			mockAuthProvider.close = closeMock
			hub.connectToServer.mockImplementation(async () => {
				mcpHub.connections = [
					{
						...mockConnection,
						server: { ...mockConnection.server, status: "disconnected", error: "reconnect failed" },
					},
				]
				throw new Error("reconnect failed")
			})
			// Two subscriptions happen: the cross-window pre-read watcher in
			// _initiateOAuthFlow stays silent; the flow watcher delivers valid tokens.
			let subscriptions = 0
			mockSecretStorage.onDidChange.mockImplementation((_url: string, cb: () => void) => {
				subscriptions += 1
				if (subscriptions === 1) return vi.fn()
				queueMicrotask(() => {
					mockSecretStorage.getOAuthData.mockResolvedValue({ expires_at: Date.now() + 10 * 60 * 1000 })
					cb()
				})
				return vi.fn()
			})

			// Must resolve through the catch path instead of staying pending forever.
			await hub._initiateOAuthFlow(serverName, source, config, mockAuthProvider, {}, mockConnection)

			expect(mcpHub.connections[0]?.server.status).toBe("disconnected")
			expect(mcpHub.connections[0]?.server.error).toBe("reconnect failed")
			expect(hub.appendErrorMessage).not.toHaveBeenCalledWith(mockConnection, "reconnect failed")
			expect(closeMock).toHaveBeenCalled()
			expect(hub.oauthFlows.size).toBe(0)
		})

		it("ends the flow and surfaces the error when the Authenticate fast-path reconnect throws", async () => {
			vsc.window.showInformationMessage.mockResolvedValueOnce(t("mcp:oauth.flow.authenticateButton"))
			mockSecretStorage.getOAuthData
				.mockResolvedValueOnce(undefined) // no tokens before the flow starts
				.mockResolvedValue({ expires_at: Date.now() + 10 * 60 * 1000 }) // tokens at click time
			const hub = mcpHub as unknown as {
				oauthFlows: Map<string, unknown>
				_initiateOAuthFlow: (
					name: string,
					source: "global" | "project",
					config: unknown,
					authProvider: unknown,
					transport: unknown,
					connection: unknown,
				) => Promise<void>
				appendErrorMessage: Mock & ((connection: unknown, message: string) => void)
				connectToServer: Mock & ((...args: unknown[]) => Promise<void>)
			}
			hub.connectToServer.mockImplementation(async () => {
				mcpHub.connections = [
					{
						...mockConnection,
						server: { ...mockConnection.server, status: "disconnected", error: "fast reconnect failed" },
					},
				]
				throw new Error("fast reconnect failed")
			})

			await hub._initiateOAuthFlow(serverName, source, config, mockAuthProvider, {}, mockConnection)

			expect(mcpHub.connections[0]?.server.status).toBe("disconnected")
			expect(mcpHub.connections[0]?.server.error).toBe("fast reconnect failed")
			expect(hub.appendErrorMessage).not.toHaveBeenCalledWith(mockConnection, "fast reconnect failed")
			expect(hub.oauthFlows.size).toBe(0)
		})

		it("does not wait for an ended flow when a tool call hits a 401", async () => {
			vi.useFakeTimers()
			const requestMock = vi.fn().mockRejectedValue(new UnauthorizedError())
			// Minimal connected-connection double: request rejects with 401, the
			// transport and client close, and the auth provider drives the flow.
			const localConnection = {
				type: "connected",
				server: { name: serverName, config: JSON.stringify(config), status: "connected", source },
				client: { close: vi.fn().mockResolvedValue(undefined), request: requestMock },
				transport: { close: vi.fn().mockResolvedValue(undefined) },
				authProvider: mockAuthProvider,
			} as unknown as ConnectedMcpConnection
			mcpHub.connections = [localConnection]

			// This test drives the real findConnection, deleteConnection, and OAuth flow.
			vi.mocked(mcpHub["findConnection"]).mockRestore()
			vi.mocked(mcpHub["deleteConnection"]).mockRestore()

			const hub = mcpHub as unknown as {
				oauthFlows: Map<string, unknown>
				callTool: typeof mcpHub.callTool
				deleteConnection: (name: string, source?: "global" | "project") => Promise<void>
			}

			const callPromise = mcpHub.callTool(serverName, "some-tool", {}, source)
			await vi.advanceTimersByTimeAsync(0)
			// The 401 started a real OAuth flow and the tool call is waiting on it.
			expect(hub.oauthFlows.size).toBe(1)
			expect(requestMock).toHaveBeenCalledTimes(1)

			// Deleting the connection ends the flow through the shared removal path.
			// Attach the rejection expectation first so the fast failure is handled.
			const callAssertion = expect(callPromise).rejects.toThrow(
				`Failed to reconnect to server ${serverName} after OAuth`,
			)
			await hub.deleteConnection(serverName, source)
			await vi.advanceTimersByTimeAsync(1000)

			// The tool call must fail fast, not wait for the 5-minute flow timeout.
			await callAssertion
			expect(hub.oauthFlows.size).toBe(0)
		})
	})

	describe("OAuth reconnect fault injection (connect path)", () => {
		const serverName = "rejected-server"
		const serverUrl = "https://rejected.example.com/mcp"

		/**
		 * Wires the SDK doubles so every `client.connect()` rejects with
		 * UnauthorizedError for the first `rejectCount` attempts. The saved token in
		 * SecretStorage never expires, so each 401 drives the automatic reconnect
		 * path exactly like the issue's fake-server reproduction did.
		 */
		async function setupRejectingServer(
			rejectCount: number,
			hasMetadata = true,
		): Promise<{ connectCount: () => number }> {
			let connectCount = 0
			const connect = vi.fn(async () => {
				connectCount += 1
				if (connectCount <= rejectCount) {
					throw new UnauthorizedError()
				}
			})
			const streamableModule = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
			vi.mocked(streamableModule.StreamableHTTPClientTransport).mockImplementation(function () {
				return { close: vi.fn().mockResolvedValue(undefined) } as unknown as StreamableHTTPClientTransport
			})
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			vi.mocked(clientModule.Client).mockImplementation(function () {
				return {
					connect,
					close: vi.fn().mockResolvedValue(undefined),
					getInstructions: vi.fn(),
					request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				} as unknown as Client
			})
			const authProvider = {
				hasMetadata,
				registerClientIfNeeded: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
			}
			vi.mocked(McpOAuthClientProvider.create).mockResolvedValue(
				authProvider as unknown as McpOAuthClientProvider,
			)
			return { connectCount: () => connectCount }
		}

		/** A hub whose SecretStorage holds one unexpired, never-changing saved token. */
		async function createHubWithSavedToken(): Promise<McpHubType> {
			const secretStorage = {
				hasOAuthData: vi.fn().mockResolvedValue(true),
				getOAuthData: vi.fn().mockResolvedValue({
					tokens: { access_token: "rejected-token" },
					expires_at: Date.now() + 60 * 60 * 1000,
					issuer: "https://auth.example.com",
				}),
				onDidChange: vi.fn().mockReturnValue(vi.fn()),
				deleteOAuthData: vi.fn().mockResolvedValue(undefined),
			}
			// No project config in this harness: the project-level initialization
			// must not connect a second copy of the server.
			vi.mocked(fs.access).mockRejectedValue(new Error("no project config"))
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						[serverName]: {
							type: "streamable-http",
							url: serverUrl,
						},
					},
				}),
			)
			const hub = new McpHub(mockProvider as ClineProvider, secretStorage as unknown as SecretStorageService)
			await hub.waitUntilReady()
			return hub
		}

		it("ends in connected when the server accepts the token after two 401s", async () => {
			const { connectCount } = await setupRejectingServer(2)
			const hub = await createHubWithSavedToken()
			try {
				await vi.waitFor(() => {
					const conn = hub.connections.find((c) => c.server.name === serverName)
					expect(conn?.server.status).toBe("connected")
				})
				// Initial connect plus one reconnect per rejected attempt.
				expect(connectCount()).toBe(3)
			} finally {
				await hub.dispose()
			}
		})

		it.each([true, false])("bounds rejected-token retries after discovery (metadata=%s)", async (hasMetadata) => {
			const { connectCount } = await setupRejectingServer(Number.POSITIVE_INFINITY, hasMetadata)
			const hub = await createHubWithSavedToken()
			try {
				await vi.waitFor(() => {
					const conn = hub.connections.find((c) => c.server.name === serverName)
					expect(conn?.server.status).toBe("disconnected")
				})
				// One initial connect plus the bounded retries — then the loop stops.
				expect(connectCount()).toBe(1 + OAUTH_TOKEN_RETRY_MAX_ATTEMPTS)
				const conn = hub.connections.find((c) => c.server.name === serverName)
				expect(conn?.server.error).toBe(t("mcp:oauth.flow.retriesExhausted", { name: serverName }))
				// Let any remaining detached work settle; the count must stay bounded.
				await new Promise((resolve) => setTimeout(resolve, 20))
				expect(connectCount()).toBe(1 + OAUTH_TOKEN_RETRY_MAX_ATTEMPTS)
			} finally {
				await hub.dispose()
			}
		})

		it("records stdio errors while the process is connecting", async () => {
			await setupRejectingServer(0)
			const hub = await createHubWithSavedToken()
			const stdio = await import("@modelcontextprotocol/sdk/client/stdio.js")
			vi.mocked(stdio.StdioClientTransport).mockImplementation(function () {
				// The transport double supplies process startup, close, and the absent stderr stream.
				return {
					start: vi.fn().mockResolvedValue(undefined),
					close: vi.fn().mockResolvedValue(undefined),
					stderr: null,
				} as unknown as InstanceType<typeof stdio.StdioClientTransport>
			})
			try {
				await hub["connectToServer"](
					"stdio-errors",
					ServerConfigSchema.parse({ type: "stdio", command: "node" }),
					"global",
				)
				const connection = hub.connections.find((entry) => entry.server.name === "stdio-errors")
				if (!connection || connection.type !== "connected") throw new Error("Missing stdio connection")
				connection.server.status = "connecting"
				await connection.transport.onerror?.(new Error("stdio startup failed"))
				expect(connection.server.status).toBe("disconnected")
				expect(connection.server.error).toContain("stdio startup failed")
			} finally {
				await hub.dispose()
			}
		})

		it.each(["401", "generic"])("ignores a %s error from an old HTTP transport", async (kind) => {
			await setupRejectingServer(0)
			const hub = await createHubWithSavedToken()
			try {
				const old = hub.connections[0]
				if (!old || old.type !== "connected") throw new Error("Missing old connection")
				await hub["connectToServer"](
					serverName,
					hub["validateServerConfig"](JSON.parse(old.server.config), serverName),
					"global",
				)
				const replacement = hub.connections[0]
				const before = structuredClone(replacement?.server)
				const error = kind === "401" ? new UnauthorizedError() : new Error("late HTTP failure")
				await old.transport.onerror?.(error)
				expect(replacement?.server).toEqual(before)
				expect(hub["oauthFlows"].size).toBe(0)
			} finally {
				await hub.dispose()
			}
		})

		it.each(["connecting", "connected"] as const)(
			"handles a current generic HTTP error while %s",
			async (status) => {
				await setupRejectingServer(0)
				const hub = await createHubWithSavedToken()
				try {
					const connection = hub.connections[0]
					if (!connection || connection.type !== "connected") throw new Error("Missing connection")
					connection.server.status = status
					await connection.transport.onerror?.(new Error("current HTTP failure"))
					expect(connection.server.status).toBe(status === "connecting" ? "connecting" : "disconnected")
					if (status === "connecting") expect(connection.server.error).not.toContain("current HTTP failure")
					else expect(connection.server.error).toContain("current HTTP failure")
				} finally {
					await hub.dispose()
				}
			},
		)

		it("starts a new transport re-auth flow for a replacement connection", async () => {
			await setupRejectingServer(0)
			const hub = await createHubWithSavedToken()
			const releases: Array<() => void> = []
			const initiate = vi.fn<(typeof hub)["performOAuthFlow"]>(
				() => new Promise<void>((resolve) => releases.push(resolve)),
			)
			hub["performOAuthFlow"] = initiate
			try {
				const first = hub.connections[0]
				if (!first || first.type !== "connected") throw new Error("Missing first connection")
				first.transport.onerror?.(new UnauthorizedError())
				await hub["connectToServer"](
					serverName,
					hub["validateServerConfig"](JSON.parse(first.server.config), serverName),
					"global",
				)
				const second = hub.connections[0]
				if (!second || second.type !== "connected") throw new Error("Missing replacement connection")
				expect(second).not.toBe(first)
				second.transport.onerror?.(new UnauthorizedError())
				expect(initiate).toHaveBeenCalledTimes(2)
				expect(hub["oauthFlows"].size).toBe(1)
			} finally {
				for (const release of releases) release()
				await Promise.all([...hub["oauthFlows"].values()].map((flow) => flow.promise))
				await hub.dispose()
			}
		})

		it("does not reset the rejected-token budget when initialize succeeds", async () => {
			const { connectCount } = await setupRejectingServer(0)
			const hub = await createHubWithSavedToken()
			try {
				for (let attempt = 0; attempt <= OAUTH_TOKEN_RETRY_MAX_ATTEMPTS; attempt++) {
					const connection = hub.connections.find((entry) => entry.server.name === serverName)
					if (!connection || connection.type !== "connected" || !connection.authProvider)
						throw new Error("Missing connection")
					connection.server.status = "connecting"
					await hub["_initiateOAuthFlow"](
						serverName,
						"global",
						hub["validateServerConfig"](JSON.parse(connection.server.config), serverName),
						connection.authProvider,
						connection.transport as StreamableHTTPClientTransport,
						connection,
					)
				}
				expect(connectCount()).toBe(1 + OAUTH_TOKEN_RETRY_MAX_ATTEMPTS)
				expect(hub.connections[0]?.server.status).toBe("disconnected")
				expect(hub.connections[0]?.server.error).toBe(
					t("mcp:oauth.flow.retriesExhausted", { name: serverName }),
				)
			} finally {
				await hub.dispose()
			}
		})

		it("delays each automatic reconnect of the same rejected token", async () => {
			await setupRejectingServer(Number.POSITIVE_INFINITY)
			const hub = await createHubWithSavedToken()
			try {
				const delayModule = await import("delay")
				const delayMock = vi.mocked(delayModule.default)
				await vi.waitFor(() => {
					const conn = hub.connections.find((c) => c.server.name === serverName)
					expect(conn?.server.status).toBe("disconnected")
				})
				// Exponential backoff for the three bounded attempts. Filter out the
				// unrelated short delays the hub uses elsewhere (100ms, 500ms).
				const backoffCalls = delayMock.mock.calls.map((args) => args[0]).filter((ms) => ms >= 1000)
				expect(backoffCalls).toEqual([1000, 2000, 4000])
			} finally {
				await hub.dispose()
			}
		})

		it("updates the panel when the status changes to connected and again when the lists arrive", async () => {
			let resolveTools!: (value: { tools: Array<{ name: string }> }) => void
			const streamableModule = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
			vi.mocked(streamableModule.StreamableHTTPClientTransport).mockImplementation(function () {
				return { close: vi.fn().mockResolvedValue(undefined) } as unknown as StreamableHTTPClientTransport
			})
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			vi.mocked(clientModule.Client).mockImplementation(function () {
				return {
					connect: vi.fn().mockResolvedValue(undefined),
					close: vi.fn().mockResolvedValue(undefined),
					getInstructions: vi.fn(),
					request: vi.fn((request: { method: string }) => {
						if (request.method === "tools/list") {
							return new Promise((resolve) => {
								resolveTools = resolve
							})
						}
						return Promise.resolve({ resources: [], resourceTemplates: [] })
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
			const secretStorage = {
				hasOAuthData: vi.fn().mockResolvedValue(false),
				onDidChange: vi.fn().mockReturnValue(vi.fn()),
			}
			vi.mocked(fs.access).mockRejectedValue(new Error("no project config"))
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						[serverName]: {
							type: "streamable-http",
							url: serverUrl,
						},
					},
				}),
			)
			const hub = new McpHub(mockProvider as ClineProvider, secretStorage as unknown as SecretStorageService)
			try {
				const notifySpy = vi.spyOn(
					hub as unknown as { notifyWebviewOfServerChanges: () => Promise<void> },
					"notifyWebviewOfServerChanges",
				)
				const ready = hub.waitUntilReady()
				const conn = () => {
					const found = hub.connections.find((c) => c.server.name === serverName)
					return found?.type === "connected" ? found : undefined
				}

				// The panel shows connected while the tools list is still pending.
				await vi.waitFor(() => {
					expect(conn()?.server.status).toBe("connected")
					expect(notifySpy).toHaveBeenCalledTimes(1)
				})
				expect(conn()?.server.tools).toBeUndefined()

				// When the lists arrive, the panel updates again with their results.
				resolveTools!({ tools: [{ name: "slow-tool" }] })
				await ready
				// The early connected update plus at least one post-list update.
				await vi.waitFor(() => expect(notifySpy.mock.calls.length).toBeGreaterThanOrEqual(2))
				expect(conn()?.server.tools).toEqual([
					{ name: "slow-tool", alwaysAllow: false, enabledForPrompt: true },
				])
			} finally {
				await hub.dispose()
			}
		})
	})
})
