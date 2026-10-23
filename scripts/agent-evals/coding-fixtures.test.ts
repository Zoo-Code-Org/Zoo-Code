import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { configurationMatchesToolPolicy, validateFixture } from "./contract.ts"
import { CODING_FIXTURE_BUNDLES } from "./coding-fixtures.ts"
import { CODING_SUITE_ID, codingBundle, codingSuiteDigest } from "./coding-suite.ts"
import { GRADER_VERSION } from "./coding-grader.ts"

const CREDENTIAL = "sk-test-credential-for-projection-check"

describe("coding fixture suite", () => {
	it("exposes exactly five fixtures", () => {
		assert.equal(CODING_FIXTURE_BUNDLES.length, 5)
		assert.equal(new Set(CODING_FIXTURE_BUNDLES.map((bundle) => bundle.fixture.identity.name)).size, 5)
	})

	it("passes the substrate contract for every fixture", () => {
		for (const bundle of CODING_FIXTURE_BUNDLES) validateFixture(bundle.fixture)
	})

	it("builds configurations that match the declared tool policy", () => {
		for (const bundle of CODING_FIXTURE_BUNDLES) {
			const config = bundle.fixture.buildConfiguration(CREDENTIAL) as Record<string, unknown>
			assert.equal(configurationMatchesToolPolicy(config, bundle.fixture.toolPolicy), true)
		}
	})

	it("keeps the credential out of the settings projection", () => {
		for (const bundle of CODING_FIXTURE_BUNDLES) {
			const projectionJson = JSON.stringify(bundle.fixture.settingsProjection)
			assert.equal(projectionJson.includes(CREDENTIAL), false)
			const configJson = JSON.stringify(bundle.fixture.buildConfiguration(CREDENTIAL))
			assert.equal(configJson.includes(CREDENTIAL), true)
		}
	})

	it("ships hidden tests that are absent from the run workspace", () => {
		for (const bundle of CODING_FIXTURE_BUNDLES) {
			assert.ok(bundle.grading.hiddenTests.length > 0)
			for (const hidden of bundle.grading.hiddenTests)
				assert.equal(
					bundle.fixture.workspace.files.some((file) => file.path === hidden.path),
					false,
					`hidden test leaked into workspace: ${hidden.path}`,
				)
		}
	})

	it("ships two distinct reference solutions over existing workspace paths", () => {
		for (const bundle of CODING_FIXTURE_BUNDLES) {
			assert.ok(bundle.grading.correctSolution.length > 0)
			const workspacePaths = new Set(bundle.fixture.workspace.files.map((file) => file.path))
			for (const file of [...bundle.grading.correctSolution, ...bundle.grading.incorrectSolution])
				assert.equal(workspacePaths.has(file.path), true, `solution path missing from workspace: ${file.path}`)
			const sameFiles = bundle.grading.correctSolution.every((file) => {
				const incorrect = bundle.grading.incorrectSolution.find((candidate) => candidate.path === file.path)
				return incorrect === undefined || incorrect.content !== file.content
			})
			assert.equal(sameFiles, true)
		}
	})

	it("pins the grader identity with resources and an image", () => {
		for (const bundle of CODING_FIXTURE_BUNDLES) {
			assert.ok(bundle.grading.resources.timeoutMs > 0)
			assert.ok(bundle.grading.resources.memoryMb > 0)
			assert.ok(bundle.grading.resources.cpus > 0)
			assert.ok(bundle.grading.resources.pidsLimit > 0)
			assert.match(bundle.grading.resources.image, /^node:/)
		}
	})

	it("keeps the settings projection equal to the built configuration", () => {
		// The suite and settings digests hash the projection, so the built
		// configuration must never drift from it. The credential is removed
		// and the serialized extra body is parsed before the comparison.
		for (const bundle of CODING_FIXTURE_BUNDLES) {
			const built: Record<string, unknown> = {
				...(bundle.fixture.buildConfiguration(CREDENTIAL) as Record<string, unknown>),
			}
			assert.equal(typeof built["openAiApiKey"], "string")
			delete built["openAiApiKey"]
			assert.equal(typeof built["openAiExtraBody"], "string")
			built["openAiExtraBody"] = JSON.parse(built["openAiExtraBody"] as string)
			assert.deepEqual(built, bundle.fixture.settingsProjection)
		}
	})

	it("produces a stable suite digest that tracks the grader version", () => {
		assert.equal(codingSuiteDigest(), codingSuiteDigest())
		assert.equal(codingBundle("clamp-range").fixture.identity.name, "clamp-range")
		assert.throws(() => codingBundle("unknown-fixture"))
		assert.ok(codingSuiteDigest().length === 64)
		assert.equal(CODING_SUITE_ID, "coding-basic-v1")
		assert.equal(GRADER_VERSION, "coding-grader-v2")
	})
})
