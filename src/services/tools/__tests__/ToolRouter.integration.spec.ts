import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { Mock } from "vitest"
import type { McpServer } from "@roo-code/types"
import type { ClineProvider } from "../../../core/webview/ClineProvider"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { McpHub } from "../../mcp/McpHub"
import { Bm25Ranker } from "../Bm25Ranker"
import { ToolRouter } from "../ToolRouter"

vi.mock("../../../core/webview/ClineProvider")

describe("ToolRouter with McpHub", () => {
	let directory: string
	let hub: McpHub
	// The hub holds its provider weakly, so the suite keeps the strong reference.
	let provider: Partial<ClineProvider>
	let post: Mock<ClineProvider["postMessageToWebview"]>
	const router = ToolRouter.getInstance()
	const tools = [{ serverName: "github", toolName: "issues", description: "search tickets" }]
	function addServer(): McpServer {
		const server: McpServer = {
			name: "github",
			config: JSON.stringify({ command: "node" }),
			status: "connecting",
			source: "global",
		}
		hub.connections = [{ type: "disconnected", client: null, transport: null, server }]
		return server
	}

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "tool-router-"))
		post = vi.fn<ClineProvider["postMessageToWebview"]>().mockResolvedValue(undefined)
		provider = {
			cwd: directory,
			ensureSettingsDirectoryExists: async () => directory,
			postMessageToWebview: post,
			getState: vi.fn().mockResolvedValue({ mcpEnabled: false }),
		}
		// The hub uses only cwd, settings directory, state, and webview posting.
		hub = new McpHub(provider as ClineProvider)
		await hub.waitUntilReady()
	})

	afterEach(async () => {
		await hub.dispose()
		await fs.rm(directory, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("returns empty before any servers are configured", async () => {
		expect(hub.getServers()).toEqual([])
		expect(await router.attachInitial("tickets", [], 5)).toEqual([])
		expect(await router.search("tickets", [], 5)).toEqual([])
	})

	it("invalidates the lazy index when a server is disabled and enabled", async () => {
		await fs.writeFile(
			path.join(directory, GlobalFileNames.mcpSettings),
			JSON.stringify({
				mcpServers: { github: { command: "node" } },
			}),
		)
		// An in-flight connection allows toggling without starting an external MCP process.
		addServer()
		const changed = vi.fn()
		const subscription = hub.onServerListChanged(changed)
		const rank = vi.spyOn(Bm25Ranker.prototype, "rank")
		expect(await router.search("tickets", tools, 5)).toEqual(["mcp--github--issues"])
		const firstIndex = rank.mock.calls[0][1]

		await hub.toggleServerDisabled("github", true)
		expect(changed).toHaveBeenCalledTimes(1)
		expect(hub.getServers()).toEqual([])
		expect(router["indexedTools"]).toBeUndefined()
		expect(await router.search("tickets", [], 5)).toEqual([])

		await hub.toggleServerDisabled("github", false)
		expect(changed).toHaveBeenCalledTimes(2)
		expect(hub.getServers()).toHaveLength(1)
		expect(await router.attachInitial("tickets", tools, 5)).toEqual(["mcp--github--issues"])
		expect(rank.mock.calls[1][1]).not.toBe(firstIndex)
		const enabledIndex = rank.mock.calls[1][1]
		await hub["notifyWebviewOfServerChanges"]()
		expect(changed).toHaveBeenCalledTimes(2)
		await router.search("tickets", tools, 5)
		expect(rank.mock.calls[2][1]).toBe(enabledIndex)
		subscription.dispose()
		await hub.dispose()
		expect(changed).toHaveBeenCalledTimes(2)
		expect(router["indexedTools"]).toBeUndefined()
	})

	it.each<[string, Partial<McpServer>]>([
		["name", { name: "jira" }],
		["source", { source: "project" }],
		["config", { config: JSON.stringify({ command: "python" }) }],
		["status", { status: "connected" }],
		["disabled", { disabled: true }],
		["tools", { tools: [{ name: "issues", description: "tickets" }] }],
	])("invalidates once when server %s changes", async (_field, update) => {
		const server = addServer()
		await hub["notifyWebviewOfServerChanges"]()
		const changed = vi.fn()
		hub.onServerListChanged(changed)
		await router.search("tickets", tools, 5)
		Object.assign(server, update)
		await hub["notifyWebviewOfServerChanges"]()
		expect(changed).toHaveBeenCalledTimes(1)
		expect(router["indexedTools"]).toBeUndefined()
		await hub["notifyWebviewOfServerChanges"]()
		expect(changed).toHaveBeenCalledTimes(1)
	})

	it.each(["synchronous", "asynchronous"] as const)(
		"isolates %s listener failures during notifications and disposal",
		async (mode) => {
			const failure = new Error("listener failed")
			const log = vi.spyOn(console, "error").mockImplementation(() => {})
			hub.onServerListChanged(() => {
				if (mode === "asynchronous") {
					return Promise.reject(failure)
				}
				throw failure
			})
			const changed = vi.fn()
			hub.onServerListChanged(changed)
			const server = addServer()
			post.mockClear()
			await expect(hub["notifyWebviewOfServerChanges"]()).resolves.toBeUndefined()
			expect(post).toHaveBeenCalledWith({ type: "mcpServers", mcpServers: [server] })
			expect(changed).toHaveBeenCalledTimes(1)
			expect(log).toHaveBeenCalledWith("[McpHub] Server-list change listener failed:", failure)
			await expect(hub.dispose()).resolves.toBeUndefined()
			expect(changed).toHaveBeenCalledTimes(2)
			expect(hub["serverListEvents"].listenerCount("changed")).toBe(0)
		},
	)

	it("fires the event before the settings read can fail", async () => {
		await fs.writeFile(path.join(directory, GlobalFileNames.mcpSettings), "{ not json")
		const changed = vi.fn()
		hub.onServerListChanged(changed)
		addServer()
		await expect(hub["notifyWebviewOfServerChanges"]()).rejects.toThrow()
		expect(changed).toHaveBeenCalledTimes(1)
	})

	it("fires the event and keeps going when the webview post rejects", async () => {
		const failure = new Error("post failed")
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const changed = vi.fn()
		hub.onServerListChanged(changed)
		addServer()
		post.mockClear()
		post.mockRejectedValueOnce(failure)
		await expect(hub["notifyWebviewOfServerChanges"]()).resolves.toBeUndefined()
		expect(post).toHaveBeenCalledTimes(1)
		expect(changed).toHaveBeenCalledTimes(1)
		expect(log).toHaveBeenCalledWith("[McpHub] Error calling targetProvider.postMessageToWebview:", failure)
	})
})
