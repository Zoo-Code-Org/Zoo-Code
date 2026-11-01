import { runAgentFixture, type AgentRuntime } from "../agent-evals/runner.ts"
import { getFixture } from "../agent-evals/registry.ts"
import { SOLHEIM_BASE_URL, SOLHEIM_MODEL } from "./config.ts"
import { collectEvidence, smokeCode, type SmokeCode, type SmokeEvidence } from "./evidence.ts"
import { SMOKE_FIXTURE_NAME, ensureSmokeFixtureRegistered } from "./fixture.ts"

export type SmokeRuntime = AgentRuntime

export type SmokeVerdict = {
	kind: "provider-smoke"
	model: string
	provider: string
	passed: boolean
	code: SmokeCode
	gates: {
		extensionActivated: boolean
		ipcConnected: boolean
		taskAccepted: boolean
		providerResponseSeen: boolean
		completionSeen: boolean
		childExited: boolean
	}
	durationMs: number
}

// Thin adapter: the shared controller runs the fixture and writes the trace;
// this function keeps the smoke-specific evidence gates and verdict shape.
export async function runSmoke(runtime: SmokeRuntime, apiKey: string): Promise<SmokeVerdict> {
	ensureSmokeFixtureRegistered()
	getFixture(SMOKE_FIXTURE_NAME)
	const started = runtime.now()
	const evidence: SmokeEvidence = {
		providerResponseSeen: false,
		completionSeen: false,
		unexpectedTool: false,
		aborted: false,
	}
	const result = await runAgentFixture(runtime, {
		fixtureName: SMOKE_FIXTURE_NAME,
		credential: apiKey,
		observers: {
			onAcceptedEvent: (event, taskId) => collectEvidence(evidence, event, taskId),
			shouldStop: () =>
				evidence.unexpectedTool ||
				evidence.aborted ||
				(evidence.providerResponseSeen && evidence.completionSeen),
		},
	})
	let code: SmokeCode
	switch (result.execution.code) {
		case "SETUP_FAILED":
			code = "SETUP_FAILED"
			break
		case "ACTIVATION_FAILED":
			code = "ACTIVATION_FAILED"
			break
		case "TASK_START_FAILED":
			code = "TASK_START_FAILED"
			break
		default:
			code = smokeCode(evidence, result.execution.sessionLost)
	}
	if (result.teardown.status !== "ok" && code === "OK") code = "TEARDOWN_FAILED"
	const verdict: SmokeVerdict = {
		kind: "provider-smoke",
		model: SOLHEIM_MODEL,
		provider: SOLHEIM_BASE_URL,
		passed: code === "OK",
		code,
		gates: {
			extensionActivated: result.execution.activated,
			ipcConnected: result.execution.activated,
			taskAccepted: result.execution.taskAccepted,
			providerResponseSeen: evidence.providerResponseSeen,
			completionSeen: evidence.completionSeen,
			childExited: result.teardown.hostExited,
		},
		durationMs: runtime.now() - started,
	}
	await runtime.writeArtifact("verdict.json", verdict)
	return verdict
}

export const smokeExitCode = (verdict: SmokeVerdict): number => (verdict.passed ? 0 : 1)
