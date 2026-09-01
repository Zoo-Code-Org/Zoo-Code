import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import {
	MAX_CHANGED_LINES,
	MAX_MUTANTS,
	buildManifest,
	evaluateReport,
	executableChangedLines,
	formatAnnotations,
	mutantCounts,
	parseChangedLines,
	parseNameStatus,
	selectFromGit,
	validateDisableDirectives,
} from "./stryker-diff.mjs"

describe("parseNameStatus", () => {
	it("parses added, modified, and renamed paths", () => {
		assert.deepEqual(
			parseNameStatus(
				"A\0packages/core/src/new.ts\0M\0packages/cloud/src/a.ts\0R095\0old.ts\0packages/telemetry/src/new.ts\0",
			),
			[
				{ status: "A", path: "packages/core/src/new.ts" },
				{ status: "M", path: "packages/cloud/src/a.ts" },
				{ status: "R", oldPath: "old.ts", path: "packages/telemetry/src/new.ts" },
			],
		)
	})
})

describe("parseChangedLines", () => {
	it("uses destination-side hunk ranges and ignores deletion-only hunks", () => {
		const diff = ["@@ -2,0 +3,2 @@", "@@ -10,2 +12 @@", "@@ -20,3 +21,0 @@"].join("\n")
		assert.deepEqual([...parseChangedLines(diff)], [3, 4, 12])
	})
})

describe("executableChangedLines", () => {
	it("excludes imports, interfaces, types, and comments while retaining runtime statements", () => {
		const source = [
			'import type { User } from "./types"',
			"interface State { value: string }",
			"// behavior starts below",
			"export function value(input: boolean) {",
			'  return input ? "yes" : "no"',
			"}",
		].join("\n")
		const changed = new Set([1, 2, 3, 4, 5, 6])
		assert.deepEqual([...executableChangedLines(source, changed, "source.ts")], [4, 5])
	})
})

describe("buildManifest", () => {
	it("builds explicit executable ranges for modified and new files", () => {
		const sources = {
			"packages/core/src/changed.ts": "export function changed(value: boolean) {\n\treturn value ? 1 : 2\n}\n",
			"packages/cloud/src/new.ts": "export const enabled = true\n",
		}
		const diffs = {
			"packages/core/src/changed.ts": "@@ -1,2 +1,2 @@\n",
		}
		const manifest = buildManifest(
			[
				{ status: "M", path: "packages/core/src/changed.ts" },
				{ status: "A", path: "packages/cloud/src/new.ts" },
			],
			(filePath) => sources[filePath],
			(filePath) => diffs[filePath] ?? "",
		)

		assert.deepEqual(
			manifest.packages.map(({ id, selectors }) => ({ id, selectors })),
			[
				{ id: "core", selectors: ["src/changed.ts:1-2"] },
				{ id: "cloud", selectors: ["src/new.ts:1-1"] },
			],
		)
	})

	it("returns no packages for tests, barrels, unsupported packages, and type-only changes", () => {
		const manifest = buildManifest(
			[
				{ status: "M", path: "packages/core/src/index.ts" },
				{ status: "M", path: "packages/core/src/value.spec.ts" },
				{ status: "M", path: "webview-ui/src/value.ts" },
				{ status: "M", path: "packages/cloud/src/types.ts" },
			],
			(filePath) => {
				if (filePath.endsWith("index.ts")) return 'export * from "./value.js"\n'
				if (filePath.endsWith("types.ts")) return "export interface Value { id: string }\n"
				return "export const value = true\n"
			},
			() => "@@ -1 +1 @@\n",
		)

		assert.deepEqual(manifest, { packages: [] })
	})

	it("fails rather than skipping a package over the changed-line cap", () => {
		const source = Array.from({ length: MAX_CHANGED_LINES + 1 }, (_, index) => `call(${index})`).join("\n")
		assert.throws(
			() =>
				buildManifest(
					[{ status: "A", path: "packages/telemetry/src/large.ts" }],
					() => source,
					() => "",
				),
			/split the PR or obtain a maintainer-reviewed narrow exclusion/i,
		)
	})
})

describe("selectFromGit", () => {
	it("derives changed executable ranges from the base/head merge base", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-diff-"))
		const runGit = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()

		try {
			runGit("init", "--initial-branch=main")
			runGit("config", "user.name", "Mutation Test")
			runGit("config", "user.email", "mutation@example.com")
			fs.mkdirSync(path.join(repo, "packages/core/src"), { recursive: true })
			fs.writeFileSync(
				path.join(repo, "packages/core/src/value.ts"),
				"export function value(input: boolean) {\n\treturn input ? 1 : 2\n}\n",
			)
			runGit("add", ".")
			runGit("commit", "-m", "base")
			const baseSha = runGit("rev-parse", "HEAD")
			runGit("checkout", "-b", "feature")
			fs.writeFileSync(
				path.join(repo, "packages/core/src/value.ts"),
				"export function value(input: boolean) {\n\treturn input ? 1 : 3\n}\n",
			)
			runGit("add", ".")
			runGit("commit", "-m", "change behavior")
			const headSha = runGit("rev-parse", "HEAD")

			const manifest = selectFromGit(repo, baseSha, headSha)
			assert.equal(manifest.mergeBase, baseSha)
			assert.deepEqual(
				manifest.packages.map(({ id, selectors }) => ({ id, selectors })),
				[{ id: "core", selectors: ["src/value.ts:2-2"] }],
			)
		} finally {
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})
})

describe("mutation exclusions", () => {
	it("allows a targeted mutator exclusion with a reason", () => {
		assert.doesNotThrow(() =>
			validateDisableDirectives(
				"// Stryker disable next-line EqualityOperator: equivalent for normalized input\nreturn value <= limit\n",
				new Set([1]),
				"source.ts",
			),
		)
	})

	it("rejects broad or unreasoned exclusions", () => {
		assert.throws(
			() =>
				validateDisableDirectives(
					"// Stryker disable next-line all: noisy\nreturn value\n",
					new Set([1]),
					"source.ts",
				),
			/broad or unreasoned exclusions are not allowed/,
		)
		assert.throws(
			() =>
				validateDisableDirectives(
					"// Stryker disable next-line EqualityOperator\nreturn value\n",
					new Set([1]),
					"source.ts",
				),
			/broad or unreasoned exclusions are not allowed/,
		)
	})
})

describe("report evaluation", () => {
	const packageEntry = { id: "core", root: "packages/core" }

	it("fails on surviving and uncovered changed-code mutants", () => {
		const report = {
			files: {
				"src/value.ts": {
					mutants: [
						{
							status: "Survived",
							mutatorName: "EqualityOperator",
							replacement: ">=",
							location: { start: { line: 4 } },
						},
						{
							status: "NoCoverage",
							mutatorName: "BooleanLiteral",
							replacement: "false",
							location: { start: { line: 8 } },
						},
					],
				},
			},
		}

		assert.throws(() => evaluateReport(report, packageEntry), /1 surviving and 1 uncovered/)
		assert.equal(formatAnnotations(mutantCounts(report).blocking, packageEntry.root).length, 2)
	})

	it("passes only killed or timed-out mutants within the cap", () => {
		const mutants = Array.from({ length: MAX_MUTANTS }, (_, index) => ({
			status: index === 0 ? "Timeout" : "Killed",
			location: { start: { line: index + 1 } },
		}))
		const counts = evaluateReport({ files: { "src/value.ts": { mutants } } }, packageEntry)
		assert.equal(counts.valid, MAX_MUTANTS)
	})

	it("fails when valid mutants exceed the cap", () => {
		const mutants = Array.from({ length: MAX_MUTANTS + 1 }, (_, index) => ({
			status: "Killed",
			location: { start: { line: index + 1 } },
		}))
		assert.throws(
			() => evaluateReport({ files: { "src/value.ts": { mutants } } }, packageEntry),
			/split the PR or obtain a maintainer-reviewed narrow exclusion/i,
		)
	})

	it("fails when timeouts could create false confidence", () => {
		const mutants = Array.from({ length: 10 }, (_, index) => ({
			status: index < 2 ? "Timeout" : "Killed",
			location: { start: { line: index + 1 } },
		}))
		assert.throws(
			() => evaluateReport({ files: { "src/value.ts": { mutants } } }, packageEntry),
			/result is inconclusive/,
		)
	})
})
