import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { CODING_FIXTURE_BUNDLES } from "./coding-fixtures.ts"
import { createLocalSubprocessGradingRuntime, runGrader, GRADER_VERSION } from "./coding-grader.ts"
import { CODING_GRADER_RESOURCES } from "./coding-fixtures.ts"

// Validates every grader against its two reference solutions. Runs the real
// driver and the real Node test runner. No VS Code, no provider, no network.
describe("coding graders against reference solutions", () => {
	for (const bundle of CODING_FIXTURE_BUNDLES) {
		const name = bundle.fixture.identity.name

		const gradeSolution = async (overlay: typeof bundle.grading.correctSolution) => {
			const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `coding-grade-${name}-`))
			try {
				const files = bundle.fixture.workspace.files.map((file) => ({ ...file }))
				for (const patch of overlay) {
					const index = files.findIndex((file) => file.path === patch.path)
					if (index >= 0) files[index] = { ...patch }
					else files.push({ ...patch })
				}
				return await runGrader({
					finalFiles: files,
					hiddenTests: bundle.grading.hiddenTests,
					resources: bundle.grading.resources,
					runtime: createLocalSubprocessGradingRuntime(),
					scratchDir: scratch,
				})
			} finally {
				await fs.rm(scratch, { recursive: true, force: true })
			}
		}

		it(`[${name}] passes the known-correct solution`, async () => {
			const verdict = await gradeSolution(bundle.grading.correctSolution)
			assert.equal(verdict.kind, "passed")
			if (verdict.kind === "passed") assert.ok(verdict.result.failedCount === 0)
		})

		it(`[${name}] fails the plausible incorrect solution on hidden tests only`, async () => {
			const verdict = await gradeSolution(bundle.grading.incorrectSolution)
			assert.equal(verdict.kind, "failed")
			if (verdict.kind === "failed") {
				assert.ok(verdict.result.failedCount > 0)
				for (const failure of verdict.result.failures)
					assert.match(
						path.basename(failure.file),
						/\.acceptance\.test\.js$/,
						`unexpected visible-test failure: ${failure.name}`,
					)
			}
		})

		it(`[${name}] passes visible tests even for the incorrect solution`, async () => {
			const verdict = await gradeSolution(bundle.grading.incorrectSolution)
			if (verdict.kind === "failed") {
				const visibleFailures = verdict.result.failures.filter(
					(failure) => !path.basename(failure.file).includes(".acceptance."),
				)
				assert.equal(visibleFailures.length, 0)
			}
		})
	}

	it("pins one grader version across the suite", () => {
		assert.equal(GRADER_VERSION, "coding-grader-v3")
		assert.equal(CODING_GRADER_RESOURCES.image.startsWith("node:"), true)
	})
})
