import { fork } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { HostCommandDispatcher } from "../dispatcher.js"
import { validateHostRoots } from "../roots.js"
import { VaultSecretStorage, type VaultBackend } from "../security.js"
import { HostTransport } from "../transport.js"

const childPath = fileURLToPath(new URL("../child.ts", import.meta.url))
const tsxLoader = import.meta.resolve("tsx")

describe("host security and transport", () => {
	it("requires explicit absolute roots", () => {
		expect(() =>
			validateHostRoots({
				extensionRoot: "relative",
				workspaceRoot: "/workspace",
				storageRoot: "/storage",
				appRoot: "/app",
			}),
		).toThrow("extensionRoot")
		expect(
			validateHostRoots({
				extensionRoot: "/extension",
				workspaceRoot: "/workspace",
				storageRoot: "/storage",
				appRoot: "/app",
			}),
		).toEqual({
			extensionRoot: "/extension",
			workspaceRoot: "/workspace",
			storageRoot: "/storage",
			appRoot: "/app",
		})
	})

	it("starts the child process with version metadata in its config", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "zoo-host-child-"))
		const extensionRoot = path.join(tempRoot, "extension")
		const workspaceRoot = path.join(tempRoot, "workspace")
		const storageRoot = path.join(tempRoot, "storage")
		await Promise.all([mkdir(extensionRoot), mkdir(workspaceRoot), mkdir(storageRoot)])
		await writeFile(
			path.join(extensionRoot, "extension.js"),
			`const { EventEmitter } = require("node:events")
exports.activate = async () => {
	const api = new EventEmitter()
	api.initializeHeadless = async () => {}
	api.shutdownHeadless = async () => {}
	return api
}
exports.deactivate = async () => {}
`,
		)

		try {
			const result = await new Promise<{
				code: number | null
				signal: NodeJS.Signals | null
				buildVersion: string | undefined
				initialized: boolean
				stderr: string
			}>((resolve, reject) => {
				const child = fork(childPath, [], {
					execArgv: ["--import", tsxLoader],
					stdio: ["ignore", "ignore", "pipe", "ipc"],
					env: {
						...process.env,
						ZOO_HOST_CONFIG: JSON.stringify({
							extensionRoot,
							workspaceRoot,
							storageRoot,
							appRoot: extensionRoot,
							buildVersion: "0.1.0",
						}),
					},
				})
				let buildVersion: string | undefined
				let initialized = false
				let stderr = ""
				const messageTypes: string[] = []
				const timeout = setTimeout(() => {
					child.kill("SIGKILL")
					reject(new Error(`Zoo host child did not initialize (${messageTypes.join(", ")}): ${stderr}`))
				}, 10_000)
				child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
				child.once("error", reject)
				child.on("message", (message: { type?: string; buildVersion?: string }) => {
					if (message.type) messageTypes.push(message.type)
					if (message.type === "hello") {
						buildVersion = message.buildVersion
						child.send({
							type: "hello.select",
							version: 1,
							clientVersion: "0.1.0",
							requiredCapabilities: [
								"task:start",
								"task:resume",
								"task:cancel",
								"history:list",
								"host:shutdown",
							],
						})
					}
					if (message.type === "host.heartbeat") {
						initialized = true
						child.kill("SIGTERM")
					}
				})
				child.once("close", (code, signal) => {
					clearTimeout(timeout)
					resolve({ code, signal, buildVersion, initialized, stderr })
				})
			})

			expect(result).toEqual({
				code: null,
				signal: "SIGTERM",
				buildVersion: "0.1.0",
				initialized: true,
				stderr: "",
			})
		} finally {
			await rm(tempRoot, { recursive: true, force: true })
		}
	}, 15_000)

	it("round trips secrets only through the injected vault", async () => {
		const values = new Map<string, string>()
		const backend: VaultBackend = {
			get: vi.fn(async (key) => values.get(key)),
			store: vi.fn(async (key, value) => void values.set(key, value)),
			delete: vi.fn(async (key) => void values.delete(key)),
		}
		const storage = new VaultSecretStorage(backend)
		const changes: string[] = []
		storage.onDidChange(({ key }) => changes.push(key))
		await storage.store("api-key", "secret")
		await expect(storage.get("api-key")).resolves.toBe("secret")
		await storage.delete("api-key")
		expect(changes).toEqual(["api-key", "api-key"])
		expect(backend.store).toHaveBeenCalledWith("api-key", "secret")
	})

	it("uses one monotonic sequence for ACK and DONE", async () => {
		const sent: unknown[] = []
		const transport = new HostTransport("host-1", async (message) => void sent.push(message))
		const api = {
			startHeadlessTask: vi.fn().mockResolvedValue({ taskId: "root", rootTaskId: "root" }),
		} as never
		const dispatcher = new HostCommandDispatcher(api, transport, "/workspace")
		await dispatcher.dispatch({ v: 1, id: "cmd-1", type: "task.start", workspace: "/workspace", prompt: "hello" })
		expect(sent).toMatchObject([
			{ seq: 1, type: "command.ack", commandId: "cmd-1" },
			{ seq: 2, type: "command.done", commandId: "cmd-1", data: { commandType: "task.start" } },
		])
	})

	it("rejects workspace identity changes after ACK", async () => {
		const sent: unknown[] = []
		const transport = new HostTransport("host-1", async (message) => void sent.push(message))
		const dispatcher = new HostCommandDispatcher({} as never, transport, "/workspace")
		await dispatcher.dispatch({ v: 1, id: "cmd-1", type: "task.start", workspace: "/other", prompt: "hello" })
		expect(sent).toMatchObject([
			{ seq: 1, type: "command.ack" },
			{ seq: 2, type: "command.error", error: { code: "task_failed" } },
		])
	})

	it("lists canonical root sessions for only the pinned workspace", async () => {
		const sent: unknown[] = []
		const transport = new HostTransport("host-1", async (message) => void sent.push(message))
		const api = {
			listHeadlessTaskHistory: vi.fn().mockResolvedValue([
				{ id: "root", rootTaskId: "root", workspace: "/workspace", status: "interrupted" },
				{ id: "child", rootTaskId: "root", parentTaskId: "root", workspace: "/workspace", status: "completed" },
			]),
		} as never
		const dispatcher = new HostCommandDispatcher(api, transport, "/workspace")
		await dispatcher.dispatch({ v: 1, id: "cmd-1", type: "history.list", workspace: "/workspace" })

		expect(sent).toMatchObject([
			{ seq: 1, type: "command.ack" },
			{
				seq: 2,
				type: "command.done",
				data: { commandType: "history.list", tasks: [{ rootTaskId: "root", state: "interrupted" }] },
			},
		])
	})
})
