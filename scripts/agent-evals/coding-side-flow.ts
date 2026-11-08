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
import { acquireSideOutputLock } from "./output-lock.ts"
import { invalidateSideArtifacts } from "./coding-compare.ts"
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

// One bounded diagnostic line per failed repetition. Only the error name and
// message travel to stderr; a thrown non-Error value can hold anything, so it
// is never printed.
const describeRepetitionError = (error: unknown): string =>
	error instanceof Error ? `${error.name}: ${error.message.slice(0, 500)}` : "non-Error value thrown"

export async function executeSideFlow(inputs: SideFlowInputs): Promise<SideFlowOutcome> {
	const runs: CodingRunRecord[] = []
	const abortPublication = async (): Promise<SideFlowOutcome> => {
		// Attempt both removals even if one fails. Never report completion when
		// publication or its cleanup failed.
		const cleanup = await Promise.allSettled([
			fs.rm(path.join(inputs.out, "side-results.json"), { force: true }),
			fs.rm(path.join(inputs.out, "artifacts"), { recursive: true, force: true }),
		])
		const errors: unknown[] = []
		for (const result of cleanup) {
			if (result.status === "rejected") {
				errors.push(result.reason)
				console.error(`coding-evals publication cleanup failed: ${describeRepetitionError(result.reason)}`)
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "publication cleanup failed")
		return { runs, completed: false }
	}

	for (const repetition of inputs.repetitions) {
		// An interrupt stops the loop before the next repetition starts. The
		// in-flight repetition is left to the substrate's own teardown.
		if (inputs.isInterrupted()) return abortPublication()
		try {
			runs.push(await inputs.runRepetition(repetition))
		} catch (error) {
			try {
				await fs.rm(path.join(inputs.out, "artifacts", `${repetition.fixtureName}-rep${repetition.repIndex}`), {
					recursive: true,
					force: true,
				})
			} catch (cleanupError) {
				// A partial repetition cannot accompany a completed side result.
				console.error(`coding-evals repetition cleanup failed: ${describeRepetitionError(cleanupError)}`)
				await abortPublication()
				throw new Error("repetition artifact cleanup failed", { cause: cleanupError })
			}
			// The substrate never throws for task failures. This guards wiring
			// errors only, and records them as infrastructure failures. The
			// diagnostic names the repetition so a silent failure row has an
			// operator-visible cause.
			console.error(
				`coding-evals repetition failed: fixture ${repetition.fixtureName} rep ${repetition.repIndex}: ${describeRepetitionError(error)}`,
			)
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
	if (inputs.isInterrupted()) return abortPublication()
	try {
		// Per-run artifacts are published atomically as each record exists.
		for (const record of runs) {
			if (!record.trace) continue
			const artifactDir = path.join(inputs.out, "artifacts", `${record.fixtureName}-rep${record.repIndex}`)
			await fs.mkdir(artifactDir, { recursive: true })
			if (inputs.isInterrupted()) return abortPublication()
			await writeJsonAtomic(path.join(artifactDir, "run-record.json"), record)
			if (inputs.isInterrupted()) return abortPublication()
		}
		const result = await inputs.buildResult(runs)
		if (inputs.isInterrupted()) return abortPublication()
		await writeJsonAtomic(path.join(inputs.out, "side-results.json"), result)
		if (inputs.isInterrupted()) return abortPublication()
		return { runs, completed: true }
	} catch (error) {
		try {
			await abortPublication()
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "publication failed and cleanup failed")
		}
		throw error
	}
}

// Own the entire standalone side generation, including preparation and final
// cleanup. A competing writer fails before it can invalidate any artifacts.
export async function executeSideGeneration(inputs: {
	out: string
	isInterrupted: () => boolean
	run: () => Promise<void>
	cleanup: () => Promise<void>
}): Promise<void> {
	const release = await acquireSideOutputLock(inputs.out)
	try {
		await invalidateSideArtifacts(inputs.out)
		try {
			await inputs.run()
		} finally {
			try {
				await inputs.cleanup()
			} finally {
				// Signals during final worktree cleanup invalidate a published
				// generation too. Keep the lock until rollback has finished.
				if (inputs.isInterrupted()) await invalidateSideArtifacts(inputs.out)
			}
		}
	} finally {
		release()
	}
}
