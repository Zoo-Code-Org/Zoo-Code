import type { ExtensionContext } from "vscode"

const rooConfigMocks = vi.hoisted(() => ({
	ensureCanonicalProjectConfigRootForCwd: vi.fn(),
	resolveProjectMcpFileForCwd: vi.fn(),
}))

const fsMocks = vi.hoisted(() => ({
	access: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(JSON.stringify({ mcpServers: {} })),
	writeFile: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
	stat: vi.fn().mockResolvedValue({ isFile: () => true, isDirectory: () => false }),
	unlink: vi.fn().mockResolvedValue(undefined),
	rename: vi.fn().mockResolvedValue(undefined),
	lstat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
}))

const safeWriteJsonMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const createFileSystemWatcherMock = vi.hoisted(() =>
	vi.fn().mockImplementation(() => ({
		onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
		onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
		dispose: vi.fn(),
	})),
)

vi.mock("fs/promises", () => ({
	default: fsMocks,
	...fsMocks,
}))

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: safeWriteJsonMock,
}))

vi.mock("../../roo-config", () => ({
	ensureCanonicalProjectConfigRootForCwd: rooConfigMocks.ensureCanonicalProjectConfigRootForCwd,
	resolveProjectMcpFileForCwd: rooConfigMocks.resolveProjectMcpFileForCwd,
}))

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: createFileSystemWatcherMock,
		workspaceFolders: [{ uri: { fsPath: "/test/workspace" } }],
		onDidSaveTextDocument: vi.fn(),
		onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		withProgress: vi.fn(),
	},
	ProgressLocation: { Notification: 15 },
	Uri: { file: vi.fn((fsPath: string) => ({ fsPath })) },
	RelativePattern: vi.fn().mockImplementation((base: string, pattern: string) => ({ base, pattern })),
	Disposable: { from: vi.fn(() => ({ dispose: vi.fn() })) },
}))

vi.mock("delay", () => ({ default: vi.fn().mockResolvedValue(undefined) }))
vi.mock("chokidar", () => ({
	default: {
		watch: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), close: vi.fn() }),
	},
}))
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn(),
	getDefaultEnvironment: vi.fn().mockReturnValue({ PATH: "/usr/bin" }),
}))
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: vi.fn() }))
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: vi.fn() }))
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: vi.fn() }))
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
	UnauthorizedError: class UnauthorizedError extends Error {},
}))

import * as fs from "fs/promises"
import * as vscode from "vscode"

import { McpHub } from "../McpHub"

describe("[McpHub.zooMigration.spec.ts](src/services/mcp/__tests__/McpHub.zooMigration.spec.ts)", () => {
	const provider = {
		cwd: "/test/workspace",
		ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
		ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
		postMessageToWebview: vi.fn(),
		getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
		context: {
			subscriptions: [],
			workspaceState: {} as any,
			globalState: {} as any,
			secrets: {} as any,
			extensionUri: { fsPath: "/test/path" },
			extensionPath: "/test/path",
			storagePath: "/test/path",
			globalStoragePath: "/test/path",
			storageUri: { fsPath: "/test/path" },
			globalStorageUri: { fsPath: "/test/path" },
			logUri: { fsPath: "/test/path" },
			logPath: "/test/path",
			environmentVariableCollection: {} as any,
			asAbsolutePath: (value: string) => value,
			extensionMode: 1,
			languageModelAccessInformation: {} as any,
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as ExtensionContext,
	} as any

	beforeEach(() => {
		vi.clearAllMocks()
		fsMocks.readFile.mockResolvedValue(JSON.stringify({ mcpServers: {} }))
		fsMocks.stat.mockResolvedValue({ isFile: () => true, isDirectory: () => false })
		rooConfigMocks.resolveProjectMcpFileForCwd.mockResolvedValue({
			canonicalPath: "/test/workspace/.zoo/mcp.json",
			legacyPath: "/test/workspace/.roo/mcp.json",
			activePath: "/test/workspace/.zoo/mcp.json",
			canonicalExists: true,
			legacyExists: false,
			activeExists: true,
			shouldBootstrapCanonicalFromLegacy: false,
		})
		rooConfigMocks.ensureCanonicalProjectConfigRootForCwd.mockResolvedValue({
			canonicalPath: "/test/workspace/.zoo",
			legacyPath: "/test/workspace/.roo",
			activePath: "/test/workspace/.zoo",
			canonicalExists: true,
			legacyExists: false,
			activeExists: true,
			shouldBootstrapCanonicalFromLegacy: false,
		})
	})

	it("prefers canonical Zoo project MCP path for reads", async () => {
		const hub = new McpHub(provider)

		await expect((hub as any).getProjectMcpPath()).resolves.toBe("/test/workspace/.zoo/mcp.json")
	})

	it("falls back to legacy Roo project MCP path when canonical is absent", async () => {
		rooConfigMocks.resolveProjectMcpFileForCwd.mockResolvedValue({
			canonicalPath: "/test/workspace/.zoo/mcp.json",
			legacyPath: "/test/workspace/.roo/mcp.json",
			activePath: "/test/workspace/.roo/mcp.json",
			canonicalExists: false,
			legacyExists: true,
			activeExists: true,
			shouldBootstrapCanonicalFromLegacy: true,
		})

		const hub = new McpHub(provider)

		await expect((hub as any).getProjectMcpPath()).resolves.toBe("/test/workspace/.roo/mcp.json")
	})

	it("uses whole-root bootstrap before canonical project MCP writes", async () => {
		rooConfigMocks.ensureCanonicalProjectConfigRootForCwd.mockResolvedValueOnce({
			canonicalPath: "/test/workspace/.zoo",
			legacyPath: "/test/workspace/.roo",
			activePath: "/test/workspace/.zoo",
			canonicalExists: true,
			legacyExists: true,
			activeExists: true,
			shouldBootstrapCanonicalFromLegacy: false,
		})
		rooConfigMocks.resolveProjectMcpFileForCwd.mockResolvedValueOnce({
			canonicalPath: "/test/workspace/.zoo/mcp.json",
			legacyPath: "/test/workspace/.roo/mcp.json",
			activePath: "/test/workspace/.zoo/mcp.json",
			canonicalExists: true,
			legacyExists: true,
			activeExists: true,
			shouldBootstrapCanonicalFromLegacy: false,
		})
		fsMocks.readFile.mockImplementation(async (filePath: any) => {
			if (filePath === "/test/workspace/.roo/mcp.json" || filePath === "/test/workspace/.zoo/mcp.json") {
				return JSON.stringify({ mcpServers: { legacyServer: { command: "node", args: ["legacy.js"] } } })
			}

			return JSON.stringify({ mcpServers: {} })
		})

		const hub = new McpHub(provider)
		await (hub as any).updateServerConfig("legacyServer", { disabled: true }, "project")

		expect(rooConfigMocks.ensureCanonicalProjectConfigRootForCwd).toHaveBeenCalledWith("/test/workspace")
		const canonicalWrites = safeWriteJsonMock.mock.calls.filter(
			([filePath]) => filePath === "/test/workspace/.zoo/mcp.json",
		)
		expect(canonicalWrites).toHaveLength(1)
		expect(canonicalWrites[0]).toEqual([
			"/test/workspace/.zoo/mcp.json",
			{
				mcpServers: {
					legacyServer: {
						command: "node",
						args: ["legacy.js"],
						disabled: true,
						alwaysAllow: [],
					},
				},
			},
			{ prettyPrint: true },
		])
	})

	it("watches both Zoo and Roo MCP candidates so canonical files can appear after startup", async () => {
		const previousNodeEnv = process.env.NODE_ENV
		process.env.NODE_ENV = "development"

		createFileSystemWatcherMock.mockClear()
		const hub = new McpHub(provider)
		await (hub as any).watchProjectMcpFile()

		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(4)
		expect(
			vi
				.mocked(vscode.workspace.createFileSystemWatcher)
				.mock.calls.slice(-2)
				.map(([pattern]: any[]) => pattern.pattern),
		).toEqual([".zoo/mcp.json", ".roo/mcp.json"])

		process.env.NODE_ENV = previousNodeEnv
	})
})
