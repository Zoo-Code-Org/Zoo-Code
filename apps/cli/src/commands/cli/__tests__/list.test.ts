import fs from "fs"
import os from "os"
import path from "path"
import { EventEmitter } from "events"

import { openRouterDefaultModelId, providerIdentifiers } from "@roo-code/types"

import { readWorkspaceTaskSessions } from "@/lib/task-history/index.js"

import { listModels, listSessions, parseFormat } from "../list.js"

const extensionHostMock = vi.hoisted(() => ({
	activate: vi.fn(async () => undefined),
	dispose: vi.fn(async () => undefined),
	options: [] as unknown[],
	responses: [] as unknown[],
	sendToExtension: vi.fn(),
}))

vi.mock("@/agent/index.js", () => ({
	ExtensionHost: class extends EventEmitter {
		client = {
			isInitialized: () => true,
			on: vi.fn(() => () => undefined),
		}

		constructor(options: unknown) {
			super()
			extensionHostMock.options.push(options)
		}

		activate = extensionHostMock.activate
		dispose = extensionHostMock.dispose

		sendToExtension(message: unknown): void {
			extensionHostMock.sendToExtension(message)
			for (const response of extensionHostMock.responses) {
				this.emit("extensionWebviewMessage", response)
			}
		}
	},
}))

vi.mock("@/lib/task-history/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/task-history/index.js")>()
	return {
		...actual,
		readWorkspaceTaskSessions: vi.fn(),
	}
})

describe("parseFormat", () => {
	it("defaults to json when undefined", () => {
		expect(parseFormat(undefined)).toBe("json")
	})

	it("returns json for 'json'", () => {
		expect(parseFormat("json")).toBe("json")
	})

	it("returns text for 'text'", () => {
		expect(parseFormat("text")).toBe("text")
	})

	it("is case-insensitive", () => {
		expect(parseFormat("JSON")).toBe("json")
		expect(parseFormat("Text")).toBe("text")
		expect(parseFormat("TEXT")).toBe("text")
	})

	it("throws on invalid format", () => {
		expect(() => parseFormat("xml")).toThrow('Invalid format: xml. Must be "json" or "text".')
	})

	it("throws on empty string", () => {
		expect(() => parseFormat("")).toThrow("Invalid format")
	})
})

describe("listModels", () => {
	let tempDir: string
	let workspacePath: string
	let extensionPath: string

	beforeEach(() => {
		vi.clearAllMocks()
		extensionHostMock.options.length = 0
		extensionHostMock.responses.length = 0

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roo-list-test-"))
		workspacePath = path.join(tempDir, "workspace")
		extensionPath = path.join(tempDir, "extension")
		fs.mkdirSync(workspacePath)
		fs.mkdirSync(extensionPath)
		fs.writeFileSync(path.join(extensionPath, "extension.js"), "")
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	const captureStdout = async (fn: () => Promise<void>): Promise<string> => {
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		await fn()
		return stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("")
	}

	it("creates a host with resolved paths and returns OpenRouter models", async () => {
		const models = { "openai/gpt-4.1": { contextWindow: 128000, supportsPromptCache: false } }
		extensionHostMock.responses.push(
			{ type: "unrelatedMessage" },
			{ type: "routerModels", routerModels: { [providerIdentifiers.openrouter]: models } },
		)

		const output = await captureStdout(() =>
			listModels({
				format: "json",
				workspace: path.relative(process.cwd(), workspacePath),
				extension: path.relative(process.cwd(), extensionPath),
				apiKey: "test-api-key",
				debug: true,
			}),
		)

		expect(extensionHostMock.options).toEqual([
			expect.objectContaining({
				mode: "code",
				provider: providerIdentifiers.openrouter,
				model: openRouterDefaultModelId,
				apiKey: "test-api-key",
				workspacePath,
				extensionPath,
				nonInteractive: true,
				ephemeral: true,
				debug: true,
				exitOnComplete: true,
				exitOnError: false,
				disableOutput: true,
			}),
		])
		expect(extensionHostMock.activate).toHaveBeenCalledOnce()
		expect(extensionHostMock.sendToExtension).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: { provider: providerIdentifiers.openrouter },
		})
		expect(extensionHostMock.dispose).toHaveBeenCalledOnce()
		expect(JSON.parse(output)).toEqual({ models })
	})

	it.each([
		["a malformed routerModels value", null],
		["a malformed OpenRouter value", { [providerIdentifiers.openrouter]: "invalid" }],
	])("returns an empty model record for %s", async (_description, routerModels) => {
		extensionHostMock.responses.push({ type: "routerModels", routerModels })

		const output = await captureStdout(() =>
			listModels({ format: "json", workspace: workspacePath, extension: extensionPath }),
		)

		expect(JSON.parse(output)).toEqual({ models: {} })
	})
})

describe("listSessions", () => {
	const workspacePath = process.cwd()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	const captureStdout = async (fn: () => Promise<void>): Promise<string> => {
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

		try {
			await fn()
			return stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("")
		} finally {
			stdoutSpy.mockRestore()
		}
	}

	it("uses the CLI runtime storage path and prints JSON output", async () => {
		vi.mocked(readWorkspaceTaskSessions).mockResolvedValue([
			{ id: "s1", task: "Task 1", ts: 1_700_000_000_000, mode: "code" },
		])

		const output = await captureStdout(() => listSessions({ format: "json", workspace: workspacePath }))

		expect(readWorkspaceTaskSessions).toHaveBeenCalledWith(workspacePath)
		expect(JSON.parse(output)).toEqual({
			workspace: workspacePath,
			sessions: [{ id: "s1", task: "Task 1", ts: 1_700_000_000_000, mode: "code" }],
		})
	})

	it("prints tab-delimited text output with ISO timestamps and formatted titles", async () => {
		vi.mocked(readWorkspaceTaskSessions).mockResolvedValue([
			{ id: "s1", task: "Task 1", ts: Date.UTC(2024, 0, 1, 0, 0, 0) },
			{ id: "s2", task: "   ", ts: Date.UTC(2024, 0, 1, 1, 0, 0) },
		])

		const output = await captureStdout(() => listSessions({ format: "text", workspace: workspacePath }))
		const lines = output.trim().split("\n")

		expect(lines).toEqual(["s1\t2024-01-01T00:00:00.000Z\tTask 1", "s2\t2024-01-01T01:00:00.000Z\t(untitled)"])
	})
})
