import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { RooCodeEventName, TaskCommandName, type TaskCommand, type TaskEvent } from "@roo-code/types"
import { runCodingFixtureOnce, withWorkspaceCapture } from "./coding-run.ts"
import { createLocalSubprocessGradingRuntime } from "./coding-grader.ts"
import type { AgentClient, AgentHost, AgentRuntime, FinalWorkspaceSnapshot } from "./runner.ts"
import type { AgentFixtureWorkspaceFile } from "./contract.ts"
import type { AgentTrace } from "./trace.ts"
import { codingBundle } from "./coding-suite.ts"

// Deterministic clock: each pause advances time by 100 ms so the substrate's
// bounded windows expire without real waiting.
interface SyntheticOptions {
	finalFiles: AgentFixtureWorkspaceFile[]
	complete: boolean
}

const syntheticRuntime = (options: SyntheticOptions): { runtime: AgentRuntime; traces: AgentTrace[] } => {
	const traces: AgentTrace[] = []
	let listener: ((event: unknown) => void) | undefined
	let fakeNow = 0
	const host: AgentHost = {
		get exited() {
			return true
		},
		onExit: () => {},
		signal: () => {},
	}
	const client: AgentClient = {
		isReady: true,
		onTaskEvent: (l) => {
			listener = l
		},
		onDisconnect: () => {},
		sendCommand: (command: TaskCommand) => {
			if (command.commandName !== TaskCommandName.StartNewTask) return
			const requestId = (command.data as { requestId: string }).requestId
			const emit = (event: TaskEvent): void => listener?.(event)
			emit({
				eventName: RooCodeEventName.TaskStartResponse,
				payload: [{ requestId, success: true, taskId: "task-1" }],
			})
			if (options.complete)
				emit({
					eventName: RooCodeEventName.TaskCompleted,
					payload: [
						"task-1",
						{ totalTokensIn: 1_000, totalTokensOut: 200, totalCost: 0.01, contextTokens: 5_000 },
						{ apply_diff: { attempts: 1, failures: 0 } },
						{ isSubtask: false },
					],
				})
		},
		disconnect: () => {},
	}
	const runtime: AgentRuntime = {
		launch: async () => host,
		connect: () => client,
		cleanup: async () => {},
		writeArtifact: async (fileName, value) => {
			if (fileName === "trace.json") traces.push(value as AgentTrace)
		},
		onInterrupt: () => () => {},
		now: () => fakeNow,
		pause: async () => {
			fakeNow += 100
		},
		readFinalWorkspace: async (): Promise<FinalWorkspaceSnapshot> => ({
			files: options.finalFiles,
			truncated: false,
		}),
	}
	return { runtime, traces }
}

const finalFilesWith = (solution: AgentFixtureWorkspaceFile): AgentFixtureWorkspaceFile[] => {
	const bundle = codingBundle("clamp-range")
	return bundle.fixture.workspace.files.map((file) => (file.path === solution.path ? { ...solution } : { ...file }))
}

describe("coding run orchestration", () => {
	const scratch = async (): Promise<string> => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-run-test-"))
		process.once("exit", () => {
			void fs.rm(dir, { recursive: true, force: true })
		})
		return dir
	}

	it("grades a completed correct run as correct", async () => {
		const bundle = codingBundle("clamp-range")
		const { runtime, traces } = syntheticRuntime({
			finalFiles: finalFilesWith(bundle.grading.correctSolution[0]!),
			complete: true,
		})
		const record = await runCodingFixtureOnce({
			fixtureName: "clamp-range",
			repIndex: 0,
			credential: "sk-test",
			runtime,
			gradingRuntime: createLocalSubprocessGradingRuntime(),
			scratchDir: await scratch(),
		})
		assert.equal(record.outcome.outcome, "correct")
		assert.equal(record.executionCode, "COMPLETED")
		assert.equal(record.grading?.kind, "passed")
		assert.equal(record.metrics.outcome.outcome, "correct")
		// Usage lacks cache counts, so cost accounting stays incomplete.
		assert.equal(record.metrics.cost.accountingComplete, false)
		assert.equal(traces.length, 1)
	})

	it("grades a completed but wrong workspace as incorrect", async () => {
		const bundle = codingBundle("clamp-range")
		const incorrect = bundle.grading.incorrectSolution[0]!
		const { runtime } = syntheticRuntime({ finalFiles: finalFilesWith(incorrect), complete: true })
		const record = await runCodingFixtureOnce({
			fixtureName: "clamp-range",
			repIndex: 1,
			credential: "sk-test",
			runtime,
			gradingRuntime: createLocalSubprocessGradingRuntime(),
			scratchDir: await scratch(),
		})
		// The agent completed; the hidden tests still fail.
		assert.equal(record.outcome.outcome, "incorrect")
		assert.equal(record.grading?.kind, "failed")
		assert.ok((record.grading?.failedCount ?? 0) > 0)
	})

	it("reports a run-window expiry as timed out without grading", async () => {
		const { runtime } = syntheticRuntime({ finalFiles: [], complete: false })
		const record = await runCodingFixtureOnce({
			fixtureName: "clamp-range",
			repIndex: 2,
			credential: "sk-test",
			runtime,
			gradingRuntime: createLocalSubprocessGradingRuntime(),
			scratchDir: await scratch(),
		})
		assert.equal(record.outcome.outcome, "timed-out")
		assert.equal(record.grading, undefined)
		assert.equal(record.executionCode, "TASK_RUN_TIMEOUT")
	})

	it("captures the workspace only through cleanup and never leaks scratch paths", async () => {
		const bundle = codingBundle("clamp-range")
		const inner = syntheticRuntime({
			finalFiles: finalFilesWith(bundle.grading.correctSolution[0]!),
			complete: false,
		})
		const captured = withWorkspaceCapture(inner.runtime)
		assert.equal(captured.getSnapshot(), undefined)
		await captured.runtime.cleanup()
		const snapshot = captured.getSnapshot()
		assert.ok(snapshot)
		assert.equal(snapshot.truncated, false)
		assert.ok(snapshot.files.length > 0)
	})
})
