import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import {
	MAX_CHANGED_LINES,
	MAX_MUTANTS,
	PACKAGE_CONFIGS,
	buildManifest,
	discoverRelatedTestFiles,
	evaluateReport,
	executableChangedLines,
	formatAnnotations,
	formatAnnotationCommand,
	formatBlockingMutants,
	formatSummary,
	mutantCounts,
	parseChangedLines,
	parseNameStatus,
	parseVitestTestFiles,
	preferDirectTestFiles,
	resolveVitestBinary,
	packageForPath,
	selectFromGit,
	testsFromMutationReport,
	validateDisableDirectives,
} from "./stryker-diff.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

describe("mutation testing workflow", () => {
	it("checks out the pull request merge result from the base repository", () => {
		const workflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/mutation-testing.yml"), "utf8")

		assert.ok(workflow.includes("    pull_request:"))
		assert.ok(!workflow.includes("pull_request_target:"))
		assert.ok(workflow.includes("    contents: read"))
		assert.ok(workflow.includes("- name: Checkout pull request merge result"))
		assert.ok(workflow.includes("ref: refs/pull/${{ github.event.pull_request.number }}/merge"))
		assert.ok(workflow.includes("fetch-depth: 0"))
		assert.ok(workflow.includes("persist-credentials: false"))
		assert.ok(!workflow.includes("repository: ${{ github.event.pull_request.head.repo.full_name }}"))
		assert.ok(!workflow.includes("ref: ${{ github.event.pull_request.head.sha }}"))
		assert.ok(workflow.includes("steps.mutation_report.outputs.artifact-url"))
		assert.ok(workflow.includes("open the package's mutation.html file"))
	})
})

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
			"webview-ui/src/utils/changed.ts": "export const changed = (value: boolean) => (value ? 1 : 2)\n",
			"src/utils/changed.ts": "export const changed = (value: boolean) => (value ? 1 : 2)\n",
		}
		const diffs = {
			"packages/core/src/changed.ts": "@@ -1,2 +1,2 @@\n",
			"webview-ui/src/utils/changed.ts": "@@ -1 +1 @@\n",
			"src/utils/changed.ts": "@@ -1 +1 @@\n",
		}
		const manifest = buildManifest(
			[
				{ status: "M", path: "packages/core/src/changed.ts" },
				{ status: "A", path: "packages/cloud/src/new.ts" },
				{ status: "M", path: "webview-ui/src/utils/changed.ts" },
				{ status: "M", path: "src/utils/changed.ts" },
			],
			(filePath) => sources[filePath],
			(filePath) => diffs[filePath] ?? "",
		)

		assert.deepEqual(
			manifest.packages.map(({ id, selectors }) => ({ id, selectors })),
			[
				{ id: "core", selectors: ["src/changed.ts:1-2"] },
				{ id: "cloud", selectors: ["src/new.ts:1-1"] },
				{ id: "webview", selectors: ["webview-ui/src/utils/changed.ts:1-1"] },
				{ id: "extension", selectors: ["utils/changed.ts:1-1"] },
			],
		)
		const webview = manifest.packages.find(({ id }) => id === "webview")
		const extension = manifest.packages.find(({ id }) => id === "extension")
		assert.equal(webview.runRoot, ".")
		assert.equal(webview.discoverRelatedTests, true)
		assert.equal(webview.vitestRelated, false)
		assert.equal(extension.discoverRelatedTests, true)
		assert.equal(extension.vitestRelated, false)
	})

	it("returns no packages for tests, barrels, unsupported packages, and type-only changes", () => {
		const manifest = buildManifest(
			[
				{ status: "M", path: "packages/core/src/index.ts" },
				{ status: "M", path: "packages/core/src/value.spec.ts" },
				{ status: "M", path: "webview-ui/src/value.visual.tsx" },
				{ status: "M", path: "webview-ui/src/main.tsx" },
				{ status: "M", path: "src/utils/vitest-verbosity.ts" },
				{ status: "M", path: "apps/cli/src/value.ts" },
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

describe("packageForPath", () => {
	it("routes webview and extension production code while excluding test infrastructure", () => {
		assert.equal(packageForPath("webview-ui/src/utils/path-mentions.ts").id, "webview")
		assert.equal(packageForPath("src/utils/tool-id.ts").id, "extension")
		assert.equal(packageForPath("webview-ui/src/utils/test-utils.ts"), undefined)
		assert.equal(packageForPath("src/__mocks__/vscode.js"), undefined)
		assert.equal(packageForPath("apps/vscode-e2e/src/example.ts"), undefined)
	})
})

describe("parseVitestTestFiles", () => {
	it("normalizes and deduplicates Vitest related-test results", () => {
		assert.deepEqual(
			parseVitestTestFiles(
				{
					testResults: [
						{ name: "/repo/webview-ui/src/utils/__tests__/value.test.ts" },
						{ name: "/repo/webview-ui/src/utils/__tests__/value.test.ts" },
					],
				},
				"/repo",
			),
			["webview-ui/src/utils/__tests__/value.test.ts"],
		)
	})
})

describe("preferDirectTestFiles", () => {
	it("uses matching focused specs and falls back to all related tests", () => {
		const related = [
			"webview-ui/src/__tests__/App.spec.tsx",
			"webview-ui/src/utils/__tests__/path-mentions.test.ts",
			"webview-ui/src/components/chat/__tests__/ChatView.spec.tsx",
		]
		assert.deepEqual(preferDirectTestFiles(related, ["webview-ui/src/utils/path-mentions.ts"]), [
			"webview-ui/src/utils/__tests__/path-mentions.test.ts",
		])
		assert.deepEqual(preferDirectTestFiles(related, ["webview-ui/src/utils/unmatched.ts"]), related)
	})
})

describe("related-test discovery", () => {
	it("resolves Vitest from each package before falling back to the repository", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-vitest-"))
		const extension = PACKAGE_CONFIGS.find(({ id }) => id === "extension")
		const webview = PACKAGE_CONFIGS.find(({ id }) => id === "webview")
		const extensionBinary = path.join(repo, "src/node_modules/.bin/vitest")
		const webviewBinary = path.join(repo, "webview-ui/node_modules/.bin/vitest")
		const rootBinary = path.join(repo, "node_modules/.bin/vitest")

		try {
			fs.mkdirSync(path.dirname(extensionBinary), { recursive: true })
			fs.mkdirSync(path.dirname(webviewBinary), { recursive: true })
			fs.writeFileSync(extensionBinary, "")
			fs.writeFileSync(webviewBinary, "")

			assert.equal(resolveVitestBinary(repo, extension), extensionBinary)
			assert.equal(resolveVitestBinary(repo, webview), webviewBinary)

			fs.rmSync(extensionBinary)
			fs.mkdirSync(path.dirname(rootBinary), { recursive: true })
			fs.writeFileSync(rootBinary, "")
			assert.equal(resolveVitestBinary(repo, extension), rootBinary)
		} finally {
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("reports a Vitest launch error when no binary exists", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-vitest-"))
		const reportDirectory = path.join(repo, "reports")
		const packageEntry = {
			id: "extension",
			root: "src",
			vitestConfig: "vitest.config.ts",
			selectors: ["utils/value.ts:1-1"],
		}

		try {
			fs.mkdirSync(path.join(repo, "src"), { recursive: true })
			assert.throws(
				() => discoverRelatedTestFiles(repo, packageEntry, reportDirectory),
				/extension related-test discovery could not start:.*ENOENT/,
			)
		} finally {
			fs.rmSync(repo, { recursive: true, force: true })
		}
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

describe("failure output", () => {
	const blocking = [
		{
			filePath: "core/value.ts",
			status: "Survived",
			mutatorName: "ConditionalExpression",
			replacement: "true",
			location: { start: { line: 4 } },
		},
		{
			filePath: "core/value.ts",
			status: "NoCoverage",
			mutatorName: "StringLiteral",
			replacement: '"left | right"',
			location: { start: { line: 4 } },
		},
		{
			filePath: "utils/other.ts",
			status: "Survived",
			mutatorName: "BooleanLiteral",
			replacement: "false",
			location: { start: { line: 9 } },
		},
	]

	it("lists every blocking mutant with tests, reproduction, exclusion, and report guidance", () => {
		const baseSha = "a".repeat(40)
		const headSha = "b".repeat(40)
		const summary = formatSummary(
			[
				{
					id: "extension",
					root: "src",
					selectors: ["core/value.ts:4-4"],
					testFiles: ["core/__tests__/value.test.ts"],
					reportPath: "reports/mutation/extension/mutation.html",
					changedLines: 1,
					valid: 3,
					killed: 0,
					timeout: 0,
					survived: 2,
					noCoverage: 1,
					blocking,
					result: "Failed",
				},
			],
			["extension has blocking mutants"],
			{ baseSha, headSha },
		)

		assert.ok(summary.includes("`core/__tests__/value.test.ts`"))
		assert.ok(summary.includes("#### `src/core/value.ts`"))
		assert.ok(summary.includes("#### `src/utils/other.ts`"))
		for (const mutant of blocking) assert.ok(summary.includes(mutant.mutatorName))
		assert.ok(summary.includes('"left \\| right"'))
		assert.ok(summary.includes(`node scripts/stryker-diff.mjs ci --base ${baseSha} --head ${headSha}`))
		assert.ok(summary.includes("Stryker disable next-line ConditionalExpression:"))
		assert.ok(summary.includes("`reports/mutation/extension/mutation.html`"))
		assert.ok(summary.includes("`changed-code-mutation-report` artifact"))
	})

	it("caps annotations without truncating the grouped summary", () => {
		const manyMutants = Array.from({ length: 30 }, (_, index) => ({
			filePath: `file-${Math.floor(index / 10)}.ts`,
			status: "Survived",
			mutatorName: `Mutator${index}`,
			replacement: `replacement-${index}`,
			location: { start: { line: (index % 10) + 1 } },
		}))
		const annotations = formatAnnotations(manyMutants, "src")
		const grouped = formatBlockingMutants(manyMutants, "src").join("\n")

		assert.equal(annotations.length, 20)
		for (const file of new Set(annotations.map(({ file }) => file))) {
			assert.ok(annotations.filter((annotation) => annotation.file === file).length <= 7)
		}
		for (const mutant of manyMutants) assert.ok(grouped.includes(mutant.mutatorName))
	})

	it("shares annotation limits across packages", () => {
		const state = { total: 0, perFile: new Map() }
		const first = formatAnnotations(
			Array.from({ length: 15 }, (_, index) => ({
				filePath: `first-${index}.ts`,
				status: "Survived",
				mutatorName: "BooleanLiteral",
				location: { start: { line: 1 } },
			})),
			"packages/core",
			state,
		)
		const second = formatAnnotations(
			Array.from({ length: 15 }, (_, index) => ({
				filePath: `second-${index}.ts`,
				status: "NoCoverage",
				mutatorName: "StringLiteral",
				location: { start: { line: 1 } },
			})),
			"packages/cloud",
			state,
		)

		assert.equal(first.length, 15)
		assert.equal(second.length, 5)
		assert.equal(state.total, 20)
	})

	it("preserves punctuation in annotation messages while escaping properties", () => {
		const command = formatAnnotationCommand({
			file: "src/value:one,two.ts",
			line: 4,
			message: "Survived mutant (replacement: left, right). 100% reproducible.",
		})

		assert.equal(
			command,
			"::error file=src/value%3Aone%2Ctwo.ts,line=4,title=Mutation test gap::Survived mutant (replacement: left, right). 100%25 reproducible.",
		)
	})

	it("uses the actual tests recorded by Stryker", () => {
		assert.deepEqual(
			testsFromMutationReport({ testFiles: { "src/value.test.ts": {}, "src/other.spec.ts": {} } }, [
				"fallback.test.ts",
			]),
			["src/value.test.ts", "src/other.spec.ts"],
		)
		assert.deepEqual(testsFromMutationReport({}, ["fallback.test.ts"]), ["fallback.test.ts"])
	})

	it("keeps the maximum blocking-mutant inventory within GitHub's summary limit", () => {
		const rows = Array.from({ length: 6 }, (_, packageIndex) => ({
			id: `package-${packageIndex}`,
			root: `packages/package-${packageIndex}`,
			selectors: ["src/value.ts:1-500"],
			testFiles: ["src/value.test.ts"],
			reportPath: `reports/mutation/package-${packageIndex}/mutation.html`,
			changedLines: 500,
			valid: MAX_MUTANTS,
			killed: 0,
			timeout: 0,
			survived: MAX_MUTANTS,
			noCoverage: 0,
			blocking: Array.from({ length: MAX_MUTANTS }, (_, mutantIndex) => ({
				filePath: `src/file-${mutantIndex}.ts`,
				status: "Survived",
				mutatorName: `Package${packageIndex}Mutator${mutantIndex}`,
				replacement: "x".repeat(1_000),
				location: { start: { line: 1 } },
			})),
			result: "Failed",
		}))
		const summary = formatSummary(rows, ["mutation failure"], {
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
		})

		assert.equal(new Set(summary.match(/Package\dMutator\d+/g)).size, 6 * MAX_MUTANTS)
		assert.ok(Buffer.byteLength(summary) < 1024 * 1024)
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
