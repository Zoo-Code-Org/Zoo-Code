import { describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { FileWatcher } from "../processors/file-watcher"
import { CodeIndexOrchestrator } from "../orchestrator"
import { CodeIndexStateManager } from "../state-manager"
import type { CodeIndexConfigManager } from "../config-manager"
import type { CacheManager } from "../cache-manager"
import type { DirectoryScanner } from "../processors"
import type { IVectorStore } from "../interfaces"
import { makeUri } from "../../../test-utils/vscode"

vi.mock("../processors/parser", () => ({ codeParser: {} }))
vi.mock("../processors/file-preparation", () => ({ FilePreparation: class {} }))
vi.mock("../../../core/ignore/RooIgnoreController", () => ({ RooIgnoreController: class {} }))
vi.mock("@roo-code/telemetry", () => ({ TelemetryService: { instance: { captureEvent: vi.fn() } } }))
vi.mock("vscode", () => {
	class EventEmitter<T> {
		private listeners = new Set<(value: T) => unknown>()
		event = (listener: (value: T) => unknown) => {
			this.listeners.add(listener)
			return {
				dispose: () => {
					this.listeners.delete(listener)
				},
			}
		}
		fire(value: T) {
			for (const listener of this.listeners) listener(value)
		}
		dispose() {
			this.listeners.clear()
		}
	}
	return {
		EventEmitter,
		RelativePattern: class {},
		workspace: {
			createFileSystemWatcher: () => ({
				onDidCreate: vi.fn(),
				onDidChange: vi.fn(),
				onDidDelete: vi.fn(),
				dispose: vi.fn(),
			}),
		},
	}
})

function setup() {
	// These doubles provide only the members used by watcher startup and the no-upsert batches below.
	const config = { isFeatureConfigured: true } as CodeIndexConfigManager
	const cache = {} as CacheManager
	const store = {} as IVectorStore
	const scanner = {} as DirectoryScanner
	const context = {} as vscode.ExtensionContext
	const watcher = new FileWatcher("/workspace", context, cache, undefined, store, undefined, undefined, 60)
	const state = new CodeIndexStateManager()
	const orchestrator = new CodeIndexOrchestrator(config, state, "/workspace", cache, store, scanner, watcher)
	const prepare = vi.spyOn(watcher, "processFile")
	return { watcher, state, orchestrator, prepare }
}

// Exhaust all success/failure histories up to six batches; the model's provider result is an oracle.
const histories = Array.from({ length: 64 }, (_, mask) =>
	Array.from({ length: 6 }, (_, bit) => Boolean(mask & (1 << bit))),
)

describe("watcher source-to-state properties", () => {
	it.each(histories.map((history) => [history] as const))(
		"keeps trips visible and rejects later work for %j",
		async (history) => {
			const { watcher, state, orchestrator, prepare } = setup()
			await orchestrator["_startWatcher"]()
			let failures = 0
			let open = false
			try {
				for (const [index, failed] of history.entries()) {
					prepare.mockResolvedValue({
						path: `/workspace/${index}.ts`,
						status: failed ? "local_error" : "skipped",
					})
					const before = prepare.mock.calls.length
					watcher["accumulatedEvents"].set(`/workspace/${index}.ts`, {
						uri: makeUri(`/workspace/${index}.ts`),
						type: "create",
					})
					await watcher["triggerBatchProcessing"]()
					expect(prepare.mock.calls.length - before).toBe(open ? 0 : 1)
					if (!open) failures = failed ? failures + 1 : 0
					open ||= failures >= 3
					expect(state.state).toBe(open ? "Error" : "Indexed")
					if (open) expect(state.getCurrentStatus().message).toMatch(/restart|re-run|configuration/i)
				}
				// A new subscription resets both the producer and consumer breaker state.
				await orchestrator["_startWatcher"]()
				prepare.mockResolvedValue({ path: "/workspace/recovered.ts", status: "skipped" })
				watcher["accumulatedEvents"].set("/workspace/recovered.ts", {
					uri: makeUri("/workspace/recovered.ts"),
					type: "create",
				})
				const before = prepare.mock.calls.length
				await watcher["triggerBatchProcessing"]()
				expect(prepare.mock.calls.length).toBe(before + 1)
				expect(state.state).toBe("Indexed")
			} finally {
				orchestrator.stopWatcher()
			}
		},
	)
})
