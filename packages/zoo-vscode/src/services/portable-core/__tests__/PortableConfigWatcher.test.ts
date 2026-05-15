const vscodeMock = vitest.hoisted(() => {
	const watchers: any[] = []
	const createFileSystemWatcher = vitest.fn((pattern) => {
		const callbacks = {
			create: undefined as ((uri: any) => void) | undefined,
			change: undefined as ((uri: any) => void) | undefined,
			delete: undefined as ((uri: any) => void) | undefined,
		}
		const watcher = {
			pattern,
			callbacks,
			onDidCreate: vitest.fn((callback) => {
				callbacks.create = callback
				return { dispose: vitest.fn() }
			}),
			onDidChange: vitest.fn((callback) => {
				callbacks.change = callback
				return { dispose: vitest.fn() }
			}),
			onDidDelete: vitest.fn((callback) => {
				callbacks.delete = callback
				return { dispose: vitest.fn() }
			}),
			dispose: vitest.fn(),
		}
		watchers.push(watcher)
		return watcher
	})

	return {
		watchers,
		createFileSystemWatcher,
		RelativePattern: vitest.fn((base, pattern) => ({ base, pattern })),
	}
})

vitest.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
		createFileSystemWatcher: vscodeMock.createFileSystemWatcher,
	},
	RelativePattern: vscodeMock.RelativePattern,
}))

import { PortableConfigWatcher } from "../PortableConfigWatcher"

describe("PortableConfigWatcher", () => {
	beforeEach(() => {
		vitest.useFakeTimers()
		vscodeMock.watchers.splice(0)
		vscodeMock.createFileSystemWatcher.mockClear()
		vscodeMock.RelativePattern.mockClear()
	})

	afterEach(() => {
		vitest.useRealTimers()
	})

	it("watches global and project portable config files", () => {
		const service = { reloadConfig: vitest.fn().mockResolvedValue(undefined) }
		const outputChannel = { appendLine: vitest.fn() }

		const watcher = new PortableConfigWatcher(service as any, outputChannel as any)

		expect(vscodeMock.createFileSystemWatcher).toHaveBeenCalledTimes(6)
		expect(vscodeMock.RelativePattern.mock.calls.map(([, pattern]) => pattern)).toEqual([
			"zoo.jsonc",
			"zoo.jsonc",
			"AGENTS.md",
			".zooignore",
			".zoo/rules/**/*.md",
			".zoo/modes/*.json",
		])
		watcher.dispose()
	})

	it("debounces config changes into one reload", async () => {
		const service = { reloadConfig: vitest.fn().mockResolvedValue(undefined) }
		const outputChannel = { appendLine: vitest.fn() }
		const watcher = new PortableConfigWatcher(service as any, outputChannel as any)

		vscodeMock.watchers[1].callbacks.change({ fsPath: "/workspace/zoo.jsonc" })
		vscodeMock.watchers[2].callbacks.create({ fsPath: "/workspace/AGENTS.md" })
		await vitest.advanceTimersByTimeAsync(750)

		expect(service.reloadConfig).toHaveBeenCalledOnce()
		expect(service.reloadConfig).toHaveBeenCalledWith("/workspace/AGENTS.md")
		watcher.dispose()
	})

	it("disposes watchers and pending reloads", async () => {
		const service = { reloadConfig: vitest.fn().mockResolvedValue(undefined) }
		const outputChannel = { appendLine: vitest.fn() }
		const watcher = new PortableConfigWatcher(service as any, outputChannel as any)

		vscodeMock.watchers[1].callbacks.delete({ fsPath: "/workspace/zoo.jsonc" })
		watcher.dispose()
		await vitest.advanceTimersByTimeAsync(750)

		expect(service.reloadConfig).not.toHaveBeenCalled()
		expect(vscodeMock.watchers.every((item) => item.dispose.mock.calls.length === 1)).toBe(true)
	})
})
