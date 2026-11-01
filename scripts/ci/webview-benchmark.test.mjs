import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import { compareRuns, coveredLines, summarizeReport, validateOptions } from "./webview-benchmark.mjs"

function completeRuns() {
	return ["linux", "win32"].flatMap((platform) =>
		[1, 2, 4].flatMap((workers) =>
			[1, 2].map((repetition) => ({
				platform,
				workers,
				repetition,
				sha: "source-sha",
				coverage: platform === "linux",
				exitCode: 0,
				inventory: [["src/example.spec.ts", ["suite > test"]]],
				fileCount: 1,
				testCount: 1,
				passed: 1,
				skipped: 0,
				failed: 0,
				failedFiles: 0,
				unhandledErrors: 0,
				retries: 0,
				coveredLines: platform === "linux" ? ["src/example.ts:1"] : undefined,
				wallSeconds: 1,
			})),
		),
	)
}

describe("webview benchmark evidence", () => {
	it("accepts supported workers/repetitions and rejects invalid values", () => {
		for (const workers of [1, 2, 4]) validateOptions(workers, 2)
		for (const [workers, repetitions] of [
			[0, 2],
			[3, 2],
			["2", 2],
			[2, 0],
			[2, 6],
			[2, 1.5],
			[2, NaN],
		]) {
			assert.throws(() => validateOptions(workers, repetitions))
		}
	})

	it("normalizes report ordering while retaining failures, skips and retries", () => {
		const report = summarizeReport({
			errors: [{ message: "unhandled" }],
			files: [
				{ file: "b", ok: true, tests: [{ name: "skipped", state: "skipped" }] },
				{ file: "a", ok: false, tests: [{ name: "failed", state: "failed", diagnostic: { retryCount: 1 } }] },
			],
		})
		assert.deepEqual(report.inventory, [
			["a", ["failed"]],
			["b", ["skipped"]],
		])
		assert.equal(report.testCount, 2)
		assert.equal(report.failedFiles, 1)
		assert.equal(report.failed, 1)
		assert.equal(report.skipped, 1)
		assert.equal(report.retries, 1)
		assert.equal(report.unhandledErrors, 1)
	})

	it("compares covered line identities rather than execution counts", () => {
		assert.deepEqual(coveredLines("SF:src/example.ts\r\nDA:2,3\r\nDA:1,0\r\nDA:2,1\r\nend_of_record"), [
			"src/example.ts:2",
		])
		for (const input of ["DA:1,1", "SF:src/a.ts\nDA:0,1", "SF:src/a.ts\nDA:1,-1", "SF:src/a.ts\nDA:1,invalid"]) {
			assert.throws(() => coveredLines(input), /Invalid LCOV/)
		}
	})

	it("accepts complete comparable cases and rejects missing, duplicate, failed or mismatched runs", () => {
		assert.deepEqual(compareRuns(completeRuns()), [])
		const mutations = [
			(runs) => runs.pop(),
			(runs) => {
				runs[0].repetition = 2
			},
			(runs) => {
				runs[0].exitCode = 1
			},
			(runs) => {
				runs[0].failedFiles = 1
			},
			(runs) => {
				runs[0].retries = 1
			},
			(runs) => {
				runs[0].passed = 0
			},
			(runs) => {
				runs[0].sha = "different-source"
			},
			(runs) => {
				runs[0].inventory = []
			},
			(runs) => {
				runs[0].coverage = false
			},
			(runs) => {
				runs[0].coveredLines = []
			},
			(runs) => {
				runs[0].coveredLines.push("src/other.ts:2")
			},
		]
		for (const mutate of mutations) {
			const runs = completeRuns()
			mutate(runs)
			assert.ok(compareRuns(runs).length > 0)
		}
	})

	it("writes a CLI comparison and returns failure when a case is missing", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "webview-benchmark-"))
		try {
			for (const run of completeRuns()) {
				const runDirectory = path.join(directory, `${run.platform}-${run.workers}-${run.repetition}`)
				mkdirSync(path.join(runDirectory, "coverage"), { recursive: true })
				writeFileSync(path.join(runDirectory, "metadata.json"), JSON.stringify(run))
				if (run.coverage)
					writeFileSync(
						path.join(runDirectory, "coverage/lcov.info"),
						"SF:src/example.ts\nDA:1,3\nend_of_record\n",
					)
			}
			const args = [
				fileURLToPath(new URL("./webview-benchmark.mjs", import.meta.url)),
				"--summarize",
				"--output",
				directory,
			]
			const options = { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } }
			const valid = spawnSync(process.execPath, args, options)
			assert.equal(valid.status, 0, valid.stderr)
			assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "comparison.json"), "utf8")).errors, [])
			rmSync(path.join(directory, "linux-1-1/metadata.json"))
			const invalid = spawnSync(process.execPath, args, options)
			assert.equal(invalid.status, 1, invalid.stderr)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})
