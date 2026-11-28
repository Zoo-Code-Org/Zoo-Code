import nock from "nock"
import { createServer, type ServerResponse } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as vscode from "vscode"
import type { ClineProvider } from "../../../core/webview/ClineProvider"
import type { SecretStorageService, StoredMcpOAuthData } from "../SecretStorageService"
import { t } from "../../../i18n"
import { McpHub } from "../McpHub"

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(() => ({
			onDidChange: vi.fn(),
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		})),
		onDidSaveTextDocument: vi.fn(),
		onDidChangeWorkspaceFolders: vi.fn(),
		workspaceFolders: [],
	},
	window: { showErrorMessage: vi.fn(), showInformationMessage: vi.fn(), showWarningMessage: vi.fn() },
	env: { openExternal: vi.fn() },
	Uri: { parse: (url: string) => ({ toString: () => url }) },
	Disposable: { from: vi.fn() },
	ProgressLocation: { Notification: 15 },
}))
vi.mock("../../../core/webview/ClineProvider")
vi.mock("chokidar", () => ({ default: { watch: vi.fn(() => ({ on: vi.fn().mockReturnThis(), close: vi.fn() })) } }))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

// Invariant: McpOAuthFlowEnd.NoStaleWrite. The hub, OAuth provider, SDK, and callback listener are real.
describe("OAuth ownership through the HTTP boundary", () => {
	beforeEach(() => nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/))
	afterEach(() => nock.disableNetConnect())
	it.each(
		["browser", "exchange", "reconnect"].flatMap((phase) =>
			[
				"accept",
				"delete",
				"disable",
				"dispose",
				"cancel",
				...(phase === "reconnect" ? ["timeout", "cancel-delete"] : []),
			].map((action) => ({ phase, action })),
		),
	)(
		"$action during $phase does not restore a removed or disabled server",
		async ({ phase, action }) => {
			const directory = await mkdtemp(join(tmpdir(), "mcp-ownership-"))
			const entered = deferred()
			const release = deferred()
			let initializeRequests = 0
			let base = ""
			const send = (response: ServerResponse, data: unknown, status = 200) => {
				response.writeHead(status, { "Content-Type": "application/json" })
				response.end(JSON.stringify(data))
			}
			const server = createServer((request, response) => {
				void (async () => {
					if (request.url?.includes("oauth-protected-resource")) {
						send(response, { resource: `${base}/mcp`, authorization_servers: [base] })
					} else if (request.url?.includes(".well-known")) {
						send(response, {
							issuer: base,
							authorization_endpoint: `${base}/authorize`,
							token_endpoint: `${base}/token`,
							response_types_supported: ["code"],
							grant_types_supported: ["authorization_code"],
							code_challenge_methods_supported: ["S256"],
							token_endpoint_auth_methods_supported: ["none"],
						})
					} else if (request.url === "/token") {
						if (phase === "exchange") {
							entered.resolve()
							await release.promise
						}
						send(response, { access_token: "accepted", token_type: "Bearer", expires_in: 3600 })
					} else if (request.method === "DELETE") {
						response.writeHead(200).end()
					} else if (request.method === "GET") {
						response.writeHead(405).end()
					} else {
						let body = ""
						for await (const chunk of request) body += String(chunk)
						const message = JSON.parse(body) as { id?: number; method: string }
						if (message.method === "initialize") initializeRequests++
						if (request.headers.authorization !== "Bearer accepted") {
							response.setHeader(
								"WWW-Authenticate",
								`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
							)
							send(response, { error: "unauthorized" }, 401)
						} else if (message.id === undefined) {
							response.writeHead(202).end()
						} else {
							if (phase === "reconnect" && message.method === "initialize") {
								entered.resolve()
								await release.promise
							}
							const result =
								message.method === "initialize"
									? {
											protocolVersion: "2025-03-26",
											capabilities: { tools: {}, resources: {} },
											serverInfo: { name: "local", version: "1" },
										}
									: { tools: [], resources: [], resourceTemplates: [] }
							send(response, { jsonrpc: "2.0", id: message.id, result })
						}
					}
				})().catch((error: unknown) => {
					send(response, { error: String(error) }, 500)
				})
			})
			await new Promise<void>((resolve) => {
				server.listen(0, "127.0.0.1", resolve)
			})
			const address = server.address()
			if (!address || typeof address === "string") throw new Error("Missing server address")
			base = `http://127.0.0.1:${address.port}`
			const config = { type: "streamable-http", url: `${base}/mcp`, oauth: { clientId: "static-client" } }
			await writeFile(join(directory, "mcp_settings.json"), JSON.stringify({ mcpServers: { local: config } }))
			const values = new Map<string, StoredMcpOAuthData>()
			const listeners = new Set<() => void>()
			// The store double supplies only the OAuth storage API used by the real provider.
			const storage = {
				hasOAuthData: async (url: string) => values.has(url),
				getOAuthData: async (url: string) => values.get(url),
				saveOAuthData: async (url: string, data: StoredMcpOAuthData) => {
					values.set(url, data)
					for (const listener of listeners) listener()
				},
				deleteOAuthData: async (url: string) => {
					values.delete(url)
				},
				onDidChange: (_url: string, listener: () => void) => {
					listeners.add(listener)
					return () => {
						listeners.delete(listener)
					}
				},
			} as unknown as SecretStorageService
			const panelRows: Array<Array<{ name: string; status: string; error?: string }>> = []
			// The extension double supplies settings, panel updates, and the extension version.
			const provider = {
				ensureSettingsDirectoryExists: async () => directory,
				postMessageToWebview: vi.fn(
					(message: {
						type: string
						mcpServers?: Array<{ name: string; status: string; error?: string }>
					}) => {
						if (message.type === "mcpServers" && message.mcpServers)
							panelRows.push(structuredClone(message.mcpServers))
					},
				),
				getState: async () => ({ mcpEnabled: true }),
				context: { extension: { packageJSON: { version: "1" } } },
			} as unknown as ClineProvider
			vi.mocked(vscode.env.openExternal).mockImplementation(async (uri) => {
				if (phase === "browser") {
					entered.resolve()
					await release.promise
				}
				const url = new URL(uri.toString())
				const callback = new URL(url.searchParams.get("redirect_uri")!)
				callback.searchParams.set("code", "authorization-code")
				callback.searchParams.set("state", url.searchParams.get("state")!)
				await fetch(callback)
				return true
			})
			const previous = process.env.MCP_OAUTH_TEST_MODE
			process.env.MCP_OAUTH_TEST_MODE = "true"
			// Test mode skips the notification UI but keeps the full OAuth and HTTP flow.
			const cancellationListeners = new Set<() => void>()
			const cancellationToken = {
				isCancellationRequested: false,
				onCancellationRequested: (listener: () => void) => {
					cancellationListeners.add(listener)
					return {
						dispose: () => {
							cancellationListeners.delete(listener)
						},
					}
				},
			}
			const progress = vi.fn((_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
				task({ report: vi.fn() }, cancellationToken),
			)
			Object.assign(vscode.window, { withProgress: progress })
			const hub = new McpHub(provider, storage)
			const completions: Promise<boolean>[] = []
			const complete = hub["_completeOAuthFlow"].bind(hub)
			hub["_completeOAuthFlow"] = (...args) => {
				const completion = complete(...args)
				completions.push(completion)
				return completion
			}
			try {
				await hub.waitUntilReady()
				await entered.promise
				const before = initializeRequests
				if (action === "delete") await hub.deleteConnection("local", "global")
				if (action === "disable") await hub.toggleServerDisabled("local", true, "global")
				if (action === "dispose") await hub.dispose()
				if (action === "cancel" || action === "cancel-delete") {
					cancellationToken.isCancellationRequested = true
					for (const listener of cancellationListeners) listener()
				}
				if (action === "cancel-delete") await hub.deleteConnection("local", "global")
				if (action === "timeout") {
					const flow = [...hub["oauthFlows"].values()][0]
					if (!flow) throw new Error("Missing reconnect flow")
					flow.finish("timed-out")
				}
				release.resolve()
				await vi.waitFor(() => expect(hub["oauthFlows"].size).toBe(0))
				// The flow can finish after its watcher was removed by the external action.
				await Promise.all(progress.mock.results.map((result) => result.value))
				await Promise.all(completions)
				if (action === "accept") {
					expect(hub.connections[0]?.server.status).toBe("connected")
					if (phase === "reconnect") expect(initializeRequests).toBe(before)
					else expect(initializeRequests).toBeGreaterThan(before)
				} else {
					expect(initializeRequests).toBe(before)
					if (action === "disable") expect(hub.connections[0]?.server.disabled).toBe(true)
					else if (action === "cancel" || action === "timeout") {
						expect(hub.connections).toHaveLength(1)
						expect(hub.connections[0]?.server.status).toBe("disconnected")
						expect(hub.connections[0]?.server.disabled).not.toBe(true)
						expect(hub.connections[0]?.server.error).toBe(
							t(action === "cancel" ? "mcp:oauth.flow.cancelled" : "mcp:oauth.flow.timedOut"),
						)
						await vi.waitFor(() =>
							expect(panelRows.at(-1)?.[0]).toMatchObject({
								name: "local",
								status: "disconnected",
								error: hub.connections[0]?.server.error,
							}),
						)
						if (phase === "reconnect") {
							cancellationToken.isCancellationRequested = false
							await hub.restartConnection("local", "global")
							await vi.waitFor(() => expect(hub.connections[0]?.server.status).toBe("connected"))
						}
					} else expect(hub.connections).toHaveLength(0)
				}
			} finally {
				release.resolve()
				await hub.dispose()
				if (previous === undefined) delete process.env.MCP_OAUTH_TEST_MODE
				else process.env.MCP_OAUTH_TEST_MODE = previous
				server.closeAllConnections()
				await new Promise<void>((resolve) => {
					server.close(() => resolve())
				})
				await rm(directory, { recursive: true, force: true })
			}
		},
		15000,
	)
})
