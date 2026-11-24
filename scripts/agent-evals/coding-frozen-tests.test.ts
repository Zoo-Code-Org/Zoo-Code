import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { it } from "node:test"
import { runGrader, createLocalSubprocessGradingRuntime } from "./coding-grader.ts"
import { CODING_GRADER_RESOURCES } from "./coding-fixtures.ts"

// FrozenTests: each frozen visible test reaches grading unchanged.
it("restores unchanged, edited, and deleted visible tests before real grading", async () => {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "frozen-visible-"))
	const visible = {
		path: "test/visible.test.js",
		content:
			'const { test } = require("node:test"); const assert = require("node:assert/strict"); test("frozen requirement", () => assert.equal(require("../solution.cjs"), 1))',
	}
	const hidden = {
		path: "test/hidden.test.js",
		content: 'const { test } = require("node:test"); test("hidden requirement", () => {})',
	}
	try {
		for (const solution of [1, 2]) {
			for (const mode of ["original", "changed", "missing"]) {
				const finalFiles = [{ path: "solution.cjs", content: `module.exports = ${solution}` }]
				if (mode !== "missing")
					finalFiles.push({
						...visible,
						content: mode === "changed" ? "// removed assertions" : visible.content,
					})
				const verdict = await runGrader({
					finalFiles,
					visibleTests: [visible],
					hiddenTests: [hidden],
					resources: CODING_GRADER_RESOURCES,
					runtime: createLocalSubprocessGradingRuntime(),
					scratchDir: scratch,
				})
				assert.equal(verdict.kind, solution === 1 ? "passed" : "failed", `${solution}: ${mode}`)
			}
		}
	} finally {
		await fs.rm(scratch, { recursive: true, force: true })
	}
})
