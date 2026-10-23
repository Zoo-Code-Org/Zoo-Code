import { runAgentFixture, type AgentRuntime, type FinalWorkspaceSnapshot } from "./runner.ts"
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

// Wraps a runtime so the final workspace is captured inside cleanup, before
// the launcher removes its scratch directory. The captured file data feeds
// only the fresh grading copy.
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
			try {
				snapshot = await inner.readFinalWorkspace?.()
			} catch {
				snapshot = { files: [], truncated: true }
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
	})
	const trace: AgentTrace = result.trace
	const snapshot = getSnapshot()
	const finalWorkspaceAvailable = snapshot !== undefined
	let grading: GraderVerdict | undefined
	const code = result.execution.code
	if ((code === "COMPLETED" || code === "STOPPED") && snapshot) {
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
