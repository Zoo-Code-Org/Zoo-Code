import { describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { FileWatcher } from "../processors/file-watcher"
import { CodeIndexOrchestrator } from "../orchestrator"
import { CodeIndexStateManager } from "../state-manager"
import type { CodeIndexConfigManager } from "../config-manager"
import type { CacheManager } from "../cache-manager"
import type { DirectoryScanner } from "../processors"
import type { FileProcessingResult, IVectorStore } from "../interfaces"
import { TelemetryService } from "@roo-code/telemetry"
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
	const store = {
		initialize: vi.fn<IVectorStore["initialize"]>(),
		upsertPoints: vi.fn<IVectorStore["upsertPoints"]>(),
		search: vi.fn<IVectorStore["search"]>(),
		deletePointsByFilePath: vi.fn<IVectorStore["deletePointsByFilePath"]>(),
		deletePointsByMultipleFilePaths: vi.fn<IVectorStore["deletePointsByMultipleFilePaths"]>(),
		clearCollection: vi.fn<IVectorStore["clearCollection"]>(),
		deleteCollection: vi.fn<IVectorStore["deleteCollection"]>(),
		collectionExists: vi.fn<IVectorStore["collectionExists"]>(),
		hasIndexedData: vi.fn<IVectorStore["hasIndexedData"]>(),
		markIndexingComplete: vi.fn<IVectorStore["markIndexingComplete"]>(),
		markIndexingIncomplete: vi.fn<IVectorStore["markIndexingIncomplete"]>(),
	} satisfies IVectorStore
	const scanner = {} as DirectoryScanner
	const context = {} as vscode.ExtensionContext
	const watcher = new FileWatcher("/workspace", context, cache, undefined, store, undefined, undefined, 60)
	const state = new CodeIndexStateManager()
	const orchestrator = new CodeIndexOrchestrator(config, state, "/workspace", cache, store, scanner, watcher)
	const prepare = vi.spyOn(watcher, "processFile")
	return { watcher, state, orchestrator, prepare, store }
}

function enqueueBatch(watcher: FileWatcher, path: string, type: "create" | "delete" = "create", files = 1) {
	for (let index = 0; index < files; index++) {
		const filePath = index === 0 ? path : `${path}.peer-${index}.ts`
		watcher["accumulatedEvents"].set(filePath, { uri: makeUri(filePath), type })
	}
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
					prepare.mockImplementation(async (path) => ({
						path,
						status: failed ? "local_error" : "processed_for_batching",
						pointsToUpsert: [],
						embeddingOutcome: failed ? "failure" : "success",
					}))
					const before = prepare.mock.calls.length
					enqueueBatch(watcher, `/workspace/${index}.ts`, "create", 2)
					await watcher["triggerBatchProcessing"]()
					expect(prepare.mock.calls.length - before).toBe(open ? 0 : 2)
					if (!open) failures = failed ? failures + 1 : 0
					open ||= failures >= 3
					expect(state.state).toBe(open ? "Error" : "Indexed")
					if (open) {
						expect(state.getCurrentStatus().message).toMatch(/restart|re-run|configuration/i)
						for (const total of [0, 1]) {
							watcher["_onBatchProgressUpdate"].fire({ processedInBatch: total, totalInBatch: total })
							expect(state.state).toBe("Error")
						}
					}
				}
				// A new subscription resets both the producer and consumer breaker state.
				await orchestrator["_startWatcher"]()
				prepare.mockImplementation(async (path) => ({
					path,
					status: "local_error",
					embeddingOutcome: "failure",
				}))
				enqueueBatch(watcher, "/workspace/recovered.ts", "create", 2)
				const before = prepare.mock.calls.length
				await watcher["triggerBatchProcessing"]()
				expect(prepare.mock.calls.length).toBe(before + 2)
				expect(state.state).toBe("Indexed")
			} finally {
				orchestrator.stopWatcher()
			}
		},
	)
})

const outcomes = [
	"success",
	"local",
	"singleEmbedding",
	"embedding",
	"delete",
	"idle",
	"mixed",
	"embeddingSkipped",
] as const
const sourceHistories = Array.from({ length: outcomes.length ** 4 }, (_, sequence) =>
	Array.from(
		{ length: 4 },
		(_, index) => outcomes[Math.floor(sequence / outcomes.length ** index) % outcomes.length],
	),
)

describe("watcher failure-source properties", () => {
	it.each(sourceHistories.map((history) => [history] as const))(
		"counts only shared-service failures and reports one trip for %j",
		async (history) => {
			const { watcher, state, orchestrator, prepare, store } = setup()
			const capture = vi.mocked(TelemetryService.instance.captureEvent)
			capture.mockClear()
			await orchestrator["_startWatcher"]()
			let failures = 0
			let open = false
			try {
				for (const [index, outcome] of history.entries()) {
					const path = `/workspace/${index}.ts`
					prepare.mockImplementation(async (filePath): Promise<FileProcessingResult> => {
						if (outcome === "idle" || (outcome === "embeddingSkipped" && filePath.endsWith("peer-2.ts"))) {
							return { path: filePath, status: "skipped" }
						}
						if (outcome === "local") return { path: filePath, status: "local_error" }
						const succeeded =
							outcome === "success" || (outcome === "mixed" && filePath.endsWith("peer-1.ts"))
						return {
							path: filePath,
							status: succeeded ? "processed_for_batching" : "local_error",
							pointsToUpsert: [],
							embeddingOutcome: succeeded ? "success" : "failure",
						}
					})
					vi.mocked(store.deletePointsByMultipleFilePaths).mockRejectedValue(new Error("Store unavailable"))
					const files =
						outcome === "embeddingSkipped" ? 3 : outcome === "embedding" || outcome === "mixed" ? 2 : 1
					enqueueBatch(watcher, path, outcome === "delete" ? "delete" : "create", files)
					const before = prepare.mock.calls.length
					await watcher["triggerBatchProcessing"]()
					expect(prepare.mock.calls.length - before).toBe(open || outcome === "delete" ? 0 : files)
					if (!open) {
						if (outcome === "embedding" || outcome === "embeddingSkipped" || outcome === "delete")
							failures++
						else if (outcome !== "idle" && outcome !== "local") failures = 0
					}
					open ||= failures >= 3
					expect(state.state).toBe(open ? "Error" : "Indexed")
					expect(watcher["accumulatedEvents"].size).toBe(0)
					expect(
						capture.mock.calls.filter(([, props]) => props?.errorType === "circuit_breaker_open"),
					).toHaveLength(open ? 1 : 0)
				}
			} finally {
				orchestrator.stopWatcher()
			}
		},
	)
})
