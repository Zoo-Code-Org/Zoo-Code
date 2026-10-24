import {
	runAgentFixture,
	isFinalCompletionMessage,
	type AgentRuntime,
	type AgentRunObservers,
	type FinalWorkspaceSnapshot,
} from "./runner.ts"
import { getFixture } from "./registry.ts"
import { ensureCodingSuiteRegistered, codingBundle } from "./coding-suite.ts"
import { runGrader, type GraderVerdict, type GradingRuntime } from "./coding-grader.ts"
import { classifyRunOutcome, type ClassifiedOutcome } from "./coding-outcomes.ts"
import { buildRunMetrics, type CodingRunMetrics } from "./coding-metrics.ts"
import { CODING_MODEL_ID } from "./coding-fixtures.ts"
import { measured, type AgentTrace, type Measured, type MeasuredString } from "./trace.ts"

export interface CodingRunRecord {
	fixtureName: string
	fixtureVersion: string
	repIndex: number
	outcome: ClassifiedOutcome
	executionCode?: string
	trace?: AgentTrace
	grading?: {
		kind: GraderVerdict["kind"]
		isolation?: string
		reason?: string
		failedCount?: number
		failures?: { name: string; file: string }[]
	}
	finalWorkspaceTruncated?: boolean
	metrics: CodingRunMetrics
}

// Serializes a verdict for records and reports.
export const serializeVerdict = (verdict: GraderVerdict): CodingRunRecord["grading"] => {
	switch (verdict.kind) {
		case "passed":
		case "failed":
			return {
				kind: verdict.kind,
				isolation: verdict.isolation,
				failedCount: verdict.result.failedCount,
				failures: verdict.kind === "failed" ? verdict.result.failures.slice(0, 10) : undefined,
			}
		case "grading-failure":
			return { kind: verdict.kind, isolation: verdict.isolation, reason: verdict.reason }
	}
}

const modelIdentifierFromProjection = (projection: Record<string, unknown>): MeasuredString =>
	measured(
		typeof projection["openAiModelId"] === "string" ? (projection["openAiModelId"] as string) : undefined,
		"modelIdMissingInProjection",
	)

// Headless stop policy. A headless extension host may never fire the accepted
// TaskCompleted event, so the run must not wait for the whole task-run window.
// The policy stops once the model's final non-partial completion_result
// message arrives for the accepted task. The substrate records the stop as
// adapterStopAfterCompletionMessage; it never claims an accepted completion.
// Grading below stays independent of the completion event.
export function stopOnFinalCompletionMessage(): AgentRunObservers {
	let sawFinalCompletionMessage = false
	return {
		onAcceptedEvent: (event) => {
			if (isFinalCompletionMessage(event)) sawFinalCompletionMessage = true
		},
		shouldStop: () => sawFinalCompletionMessage,
	}
}

// Wraps a runtime so the final workspace is captured inside cleanup, before
// the launcher removes its scratch directory. The captured file data feeds
// only the fresh grading copy. A rejected read leaves the snapshot undefined,
// so a broken capture becomes an infrastructure failure, never an empty
// workspace scored against the agent. A captured snapshot is never reread, so
// repeated cleanup calls cannot overwrite it.
export function withWorkspaceCapture(inner: AgentRuntime): {
	runtime: AgentRuntime
	getSnapshot: () => FinalWorkspaceSnapshot | undefined
} {
	let snapshot: FinalWorkspaceSnapshot | undefined
	// Local binding preserves the narrowing for the optional identity reader.
	const readIdentity = inner.readIdentity?.bind(inner)
	const runtime: AgentRuntime = {
		launch: (files) => inner.launch(files),
		connect: () => inner.connect(),
		cleanup: async () => {
			if (snapshot === undefined) {
				try {
					snapshot = await inner.readFinalWorkspace?.()
				} catch {
					snapshot = undefined
				}
			}
			await inner.cleanup()
		},
		writeArtifact: (fileName, value) => inner.writeArtifact(fileName, value),
		onInterrupt: (listener) => inner.onInterrupt(listener),
		now: () => inner.now(),
		pause: (ms) => inner.pause(ms),
		readIdentity: readIdentity ? () => readIdentity() : undefined,
		readFinalWorkspace: () =>
			inner.readFinalWorkspace?.() ?? Promise.reject(new Error("finalWorkspaceUnsupported")),
	}
	return { runtime, getSnapshot: () => snapshot }
}

export interface CodingRunInputs {
	fixtureName: string
	repIndex: number
	credential: string
	runtime: AgentRuntime
	gradingRuntime: GradingRuntime
	scratchDir: string
}

// One fixture repetition: substrate run, final-workspace capture, hidden-test
// grading, outcome classification, and metrics. The grader receives no
// credential. The record embeds the metadata-only trace.
export async function runCodingFixtureOnce(inputs: CodingRunInputs): Promise<CodingRunRecord> {
	ensureCodingSuiteRegistered()
	const bundle = codingBundle(inputs.fixtureName)
	const { runtime, getSnapshot } = withWorkspaceCapture(inputs.runtime)
	const result = await runAgentFixture(runtime, {
		fixtureName: inputs.fixtureName,
		credential: inputs.credential,
		observers: stopOnFinalCompletionMessage(),
	})
	const trace: AgentTrace = result.trace
	const snapshot = getSnapshot()
	const finalWorkspaceAvailable = snapshot !== undefined
	let grading: GraderVerdict | undefined
	const code = result.execution.code
	// A truncated capture is incomplete harness data. The grader never sees
	// it, so missing files can never become an incorrect verdict. Complete
	// snapshots keep grading.
	if ((code === "COMPLETED" || code === "STOPPED") && snapshot && !snapshot.truncated) {
		grading = await runGrader({
			finalFiles: snapshot.files,
			hiddenTests: bundle.grading.hiddenTests,
			resources: bundle.grading.resources,
			runtime: inputs.gradingRuntime,
			scratchDir: inputs.scratchDir,
		})
	}
	const outcome = classifyRunOutcome({
		hasTrace: true,
		executionCode: code,
		finalWorkspaceAvailable,
		finalWorkspaceTruncated: snapshot?.truncated,
		grading,
	})
	const metrics = buildRunMetrics({
		fixtureName: inputs.fixtureName,
		repIndex: inputs.repIndex,
		trace,
		grading,
		outcome,
		modelIdentifier: modelIdentifierFromProjection(bundle.fixture.settingsProjection),
	})
	return {
		fixtureName: inputs.fixtureName,
		fixtureVersion: bundle.fixture.identity.version,
		repIndex: inputs.repIndex,
		outcome,
		executionCode: code,
		trace,
		grading: grading ? serializeVerdict(grading) : undefined,
		finalWorkspaceTruncated: snapshot?.truncated,
		metrics,
	}
}

// The suite model identifier, for pinned inputs.
export const CODING_RUN_MODEL_ID = CODING_MODEL_ID
