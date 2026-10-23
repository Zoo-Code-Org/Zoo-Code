import { registerFixture, getFixture, listFixtures } from "./registry.ts"
import { validateFixture } from "./contract.ts"
import { digestValue } from "./coding-digest.ts"
import { CODING_FIXTURE_BUNDLES } from "./coding-fixtures.ts"
import { GRADER_VERSION } from "./coding-grader.ts"

// Frozen suite identity. The digest pins the exact fixture content, hidden
// tests, reference solutions, and grader version. Any edit changes the digest
// and marks cross-commit comparisons incompatible.
export const CODING_SUITE_ID = "coding-basic-v1"

let registered = false

export function ensureCodingSuiteRegistered(): void {
	if (registered) return
	registered = true
	for (const bundle of CODING_FIXTURE_BUNDLES) {
		validateFixture(bundle.fixture)
		registerFixture(bundle.fixture)
	}
}

export function codingBundle(fixtureName: string) {
	const found = CODING_FIXTURE_BUNDLES.find((candidate) => candidate.fixture.identity.name === fixtureName)
	if (!found) throw new Error(`unknown coding fixture: ${fixtureName}`)
	return found
}

// Suite digest. Canonical JSON over the frozen suite content and the grader
// identity. Computed from the in-repo data only, so the same digest holds on
// every machine.
export function codingSuiteDigest(): string {
	return digestValue({
		kind: "agent-evals-coding-suite-v1",
		suiteId: CODING_SUITE_ID,
		graderVersion: GRADER_VERSION,
		fixtures: CODING_FIXTURE_BUNDLES.map((bundle) => ({
			identity: bundle.fixture.identity,
			prompt: bundle.fixture.prompt,
			workspace: bundle.fixture.workspace,
			toolPolicy: bundle.fixture.toolPolicy,
			limits: bundle.fixture.limits,
			settingsProjection: bundle.fixture.settingsProjection,
			hiddenTests: bundle.grading.hiddenTests,
			correctSolution: bundle.grading.correctSolution,
			incorrectSolution: bundle.grading.incorrectSolution,
			resources: bundle.grading.resources,
		})),
	})
}

// Re-exports for side runners and checks.
export { listFixtures }
