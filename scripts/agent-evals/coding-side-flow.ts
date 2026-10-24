// The side execution loop: one repetition plan, interruption gates before
// each repetition and before publication, and the completion-marker
// publication. The live side wires its fixture runner into it; tests inject
// synthetic repetitions, so the gating and publication order is testable
// without a credential, a host, or a provider.
import fs from "node:fs/promises"
import path from "node:path"
import type { SideResultFile } from "./coding-compare.ts"
import type { CodingRunRecord } from "./coding-run.ts"
import { classifyRunOutcome } from "./coding-outcomes.ts"
import { buildRunMetrics } from "./coding-metrics.ts"
import { writeJsonAtomic } from "./fs-atomic.ts"

export interface SideRepetition {
	fixtureName: string
	fixtureVersion: string
	repIndex: number
}

export interface SideFlowInputs {
	// The full repetition plan of this invocation, in execution order.
	repetitions: readonly SideRepetition[]
	out: string
	// True once a terminal signal arrived. The loop checks it before each
	// repetition and again before publication.
	isInterrupted: () => boolean
	// Runs one repetition. The substrate never throws for task failures; a
	// throw is a wiring error and becomes an infrastructure-failure record.
	runRepetition: (repetition: SideRepetition) => Promise<CodingRunRecord>
	// Builds the side result that publication writes as the completion
	// marker. May be async, so the pins can describe what actually executed.
	buildResult: (runs: CodingRunRecord[]) => SideResultFile | Promise<SideResultFile>
}

export interface SideFlowOutcome {
	runs: CodingRunRecord[]
	// True when every repetition finished and the completion marker was
	// published. False when an interrupt stopped the side; no marker and no
	// artifacts exist in that case.
	completed: boolean
}

export async function executeSideFlow(inputs: SideFlowInputs): Promise<SideFlowOutcome> {
	const runs: CodingRunRecord[] = []
	for (const repetition of inputs.repetitions) {
		// An interrupt stops the loop before the next repetition starts. The
		// in-flight repetition is left to the substrate's own teardown.
		if (inputs.isInterrupted()) return { runs, completed: false }
		try {
			runs.push(await inputs.runRepetition(repetition))
		} catch {
			// The substrate never throws for task failures. This guards wiring
			// errors only, and records them as infrastructure failures.
			const outcome = classifyRunOutcome({ hasTrace: false, finalWorkspaceAvailable: false })
			runs.push({
				fixtureName: repetition.fixtureName,
				fixtureVersion: repetition.fixtureVersion,
				repIndex: repetition.repIndex,
				outcome,
				metrics: buildRunMetrics({
					fixtureName: repetition.fixtureName,
					repIndex: repetition.repIndex,
					outcome,
					modelIdentifier: { available: false, reason: "runFailed" },
				}),
			})
		}
	}
	// The completion marker must never exist for an interrupted side, so the
	// publication stays gated even when the loop itself finished.
	if (inputs.isInterrupted()) return { runs, completed: false }
	// Per-run artifacts are published atomically as each record exists.
	for (const record of runs) {
		if (!record.trace) continue
		const artifactDir = path.join(inputs.out, "artifacts", `${record.fixtureName}-rep${record.repIndex}`)
		await fs.mkdir(artifactDir, { recursive: true })
		await writeJsonAtomic(path.join(artifactDir, "run-record.json"), record)
	}
	await writeJsonAtomic(path.join(inputs.out, "side-results.json"), await inputs.buildResult(runs))
	return { runs, completed: true }
}
