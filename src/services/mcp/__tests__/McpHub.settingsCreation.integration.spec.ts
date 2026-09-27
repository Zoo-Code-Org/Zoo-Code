import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import * as lockfile from "proper-lockfile"

import type { ClineProvider } from "../../../core/webview/ClineProvider"

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { McpHub } from "../McpHub"

// McpHub loads the vscode module at import time. Watcher setup is skipped
// because Vitest runs with NODE_ENV=test; the stub only keeps the module
// graph loadable.
vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidChange: vi.fn(),
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
		onDidChangeWorkspaceFolders: vi.fn(),
		workspaceFolders: [],
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
	ProgressLocation: { Notification: 15 },
	Disposable: { from: vi.fn() },
}))

// Pass-through spy on the real proper-lockfile. Production safeWriteJson and
// this test share the same instrumented lock function, so the advisory lock,
// its retry contention, and its release behavior all stay real.
vi.mock("proper-lockfile", async () => {
	const actual = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")
	return { ...actual, lock: vi.fn(actual.lock) }
})

describe("McpHub initial settings creation (real filesystem)", () => {
	let tempDir: string
	let mcpHub: McpHub
	let mockProvider: Partial<ClineProvider>

	beforeEach(async () => {
		vi.clearAllMocks()

		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-hub-settings-"))

		mockProvider = {
			cwd: tempDir,
			ensureSettingsDirectoryExists: vi.fn().mockResolvedValue(tempDir),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
		}

		mcpHub = new McpHub(mockProvider as ClineProvider)
		// The constructor creates the stub settings file through the real
		// safeWriteJson creation path. Remove it so the test starts from a
		// machine without any MCP settings file.
		await mcpHub.waitUntilReady()
		await fs.rm(path.join(tempDir, GlobalFileNames.mcpSettings), { force: true })
	})

	afterEach(async () => {
		await mcpHub.dispose()
		await fs.rm(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("preserves a config written under the advisory lock by a concurrent creator (#1371)", async () => {
		const settingsPath = path.join(tempDir, GlobalFileNames.mcpSettings)
		const concurrentConfig = {
			mcpServers: {
				"concurrent-server": { type: "stdio", command: "node", args: ["server.js"] },
			},
		}

		let releaseB: () => Promise<void> = async () => {}
		let bLockReleased = false
		let creation: Promise<string> | undefined
		try {
			// Writer B (a lock-aware competing process) takes the real advisory
			// lock before writer A's creation pass starts. proper-lockfile can
			// lock a path whose target does not exist yet, so the file is still
			// absent at this point.
			releaseB = await lockfile.lock(settingsPath, { realpath: false })

			// Gate writer A's lock attempt. The wrapper forwards to the real
			// proper-lockfile lock, records the in-flight acquisition promise,
			// and signals the moment A calls it inside production safeWriteJson.
			const actualLock = (await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")).lock
			let aLockAttempt: ReturnType<typeof lockfile.lock> | undefined
			let signalALockAttempted: () => void = () => {}
			const aLockAttempted = new Promise<void>((resolve) => {
				signalALockAttempted = resolve
			})
			vi.mocked(lockfile.lock).mockImplementationOnce(async (filePath, options) => {
				aLockAttempt = actualLock(filePath, options)
				signalALockAttempted()
				return aLockAttempt
			})

			// Writer A enters the initial-creation path. The file is still
			// absent, so its existence check resolves false while B holds the
			// lock; the result is stale the moment B writes.
			creation = mcpHub.getMcpSettingsFilePath()

			// A must reach the real lock acquisition while B holds the lock.
			// If production safeWriteJson ever bypassed lockfile.lock, A would
			// finish the clobbering write first and this race rejects.
			await Promise.race([
				aLockAttempted,
				creation.then(() => {
					throw new Error("safeWriteJson completed without acquiring the advisory lock")
				}),
			])

			// The lock B holds is genuinely enforced at the filesystem level.
			// realpath: false stats only the .lock path; the settings file is
			// still absent at this point.
			expect(await lockfile.check(settingsPath, { realpath: false })).toBe(true)

			// Writer B commits a real configuration under its lock while A
			// waits, which is what makes A's earlier false result stale.
			await fs.writeFile(settingsPath, JSON.stringify(concurrentConfig), "utf-8")

			// A must still be blocked on B's lock. Acquiring the lock needs
			// B's release, which only a macrotask can complete, so a settled
			// attempt would flip the flag during this microtask drain.
			let aLockSettled = false
			void aLockAttempt?.then(
				() => {
					aLockSettled = true
				},
				() => {
					aLockSettled = true
				},
			)
			await Promise.resolve()
			expect(aLockSettled).toBe(false)

			// Releasing B lets A's retry acquire the lock. The locked merge
			// read then sees B's committed config instead of clobbering it.
			await releaseB()
			bLockReleased = true

			const returnedPath = await creation

			expect(returnedPath).toBe(settingsPath)

			// The creation pass must not clobber the concurrent config with the
			// empty default stub.
			const content = JSON.parse(await fs.readFile(settingsPath, "utf-8"))
			expect(content).toEqual(concurrentConfig)

			// The creation pass leaves no temp, backup, or lock artifacts
			// behind.
			const leftovers = (await fs.readdir(tempDir)).filter((entry) => entry !== GlobalFileNames.mcpSettings)
			expect(leftovers).toEqual([])
		} finally {
			// Failure paths must not leak B's lock or leave writer A pending as
			// an unhandled rejection. Awaiting a settled creation is free; on a
			// failure path it unblocks A before afterEach removes the temp dir.
			if (!bLockReleased) {
				await releaseB().catch(() => {})
			}
			if (creation) {
				await creation.catch(() => {})
			}
		}
	})
})
