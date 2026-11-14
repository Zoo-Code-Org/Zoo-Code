import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"
import { parse as parseYaml } from "yaml"

import {
	MAX_CHANGED_LINES,
	MAX_MUTANTS,
	PACKAGE_CONFIGS,
	PR_COMMENT_FILENAME,
	PR_COMMENT_MARKER,
	appendSummary,
	buildManifest,
	discoverRelatedTestFiles,
	evaluateReport,
	executableChangedLines,
	formatAnnotations,
	formatAdvisoryCommand,
	formatAnnotationCommand,
	formatBlockingMutants,
	formatPrComment,
	formatSummary,
	loadEquivalences,
	mutantCounts,
	parseChangedLines,
	parseNameStatus,
	parseVitestTestFiles,
	preferDirectTestFiles,
	resolveStrykerTempDir,
	resolveVitestBinary,
	shouldUseVitestRelated,
	packageForPath,
	runManifest,
	selectFromGit,
	testsFromMutationReport,
	validateDisableDirectives,
	validateEquivalenceEntries,
} from "./stryker-diff.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

describe("mutation testing workflow", () => {
	const readWorkflow = () =>
		fs.readFileSync(path.join(repositoryRoot, ".github/workflows/mutation-testing.yml"), "utf8")
	const shouldRun = ({ eventName, draft }) => eventName === "merge_group" || draft === false

	it("checks out the pull request merge result from the base repository", () => {
		const workflow = readWorkflow()

		assert.ok(workflow.includes("    pull_request:"))
		assert.ok(!workflow.includes("pull_request_target:"))
		assert.ok(workflow.includes("    contents: read"))
		assert.ok(workflow.includes("- name: Checkout pull request merge result"))
		assert.ok(workflow.includes("ref: ${{ github.sha }}"))
		assert.ok(!workflow.includes("ref: refs/pull/${{ github.event.pull_request.number }}/merge"))
		assert.ok(workflow.includes("fetch-depth: 0"))
		assert.ok(workflow.includes("persist-credentials: false"))
		assert.ok(!workflow.includes("repository: ${{ github.event.pull_request.head.repo.full_name }}"))
		assert.ok(!workflow.includes("ref: ${{ github.event.pull_request.head.sha }}"))
		assert.ok(workflow.includes("HEAD_SHA: ${{ github.sha }}"))
		assert.ok(workflow.includes("PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}"))
		assert.ok(!workflow.includes("                  HEAD_SHA: ${{ github.event.pull_request.head.sha }}"))
		assert.ok(workflow.includes('BASE_SHA="$(git rev-parse "$HEAD_SHA^1")"'))
		assert.ok(!workflow.includes("github.event.pull_request.base.sha"))
		assert.ok(workflow.includes("steps.mutation_report.outputs.artifact-url"))
		assert.ok(workflow.includes("open the package's mutation.html file"))
		assert.ok(workflow.includes("Enforce executable-line scope and run advisory mutation testing"))
		assert.equal(workflow.match(/continue-on-error: true/g)?.length, 1)
		assert.equal(workflow.match(/Could not write the job summary/g)?.length, 2)
		const script = fs.readFileSync(path.join(repositoryRoot, "scripts/stryker-diff.mjs"), "utf8")
		assert.ok(
			script.includes(
				"appendSummary([], manifest.advisories, manifest, path.join(reportRoot, PR_COMMENT_FILENAME))",
			),
		)
	})

	it("waits until a draft pull request is ready before emitting mutation annotations", () => {
		const workflow = readWorkflow()

		assert.ok(workflow.includes("types: [edited, opened, reopened, ready_for_review, synchronize]"))
		assert.ok(
			workflow.includes("if: github.event_name == 'merge_group' || github.event.pull_request.draft == false"),
		)

		const draftToReadyRuns = [
			{ eventName: "pull_request", action: "opened", draft: true },
			{ eventName: "pull_request", action: "ready_for_review", draft: false },
		].filter(shouldRun)

		assert.deepEqual(
			draftToReadyRuns.map(({ action }) => action),
			["ready_for_review"],
		)
	})

	it("retains mutation testing for reviewable pull request updates and the merge queue", () => {
		for (const action of ["opened", "ready_for_review", "synchronize", "reopened"]) {
			assert.equal(shouldRun({ eventName: "pull_request", draft: false }), true, action)
		}
		assert.equal(shouldRun({ eventName: "merge_group" }), true, "merge queue")
	})
})

function createSyntheticPullRequestRepository() {
	const repository = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-diff-revision-"))
	const run = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim()
	const write = (filePath, contents) => {
		fs.mkdirSync(path.join(repository, path.dirname(filePath)), { recursive: true })
		fs.writeFileSync(path.join(repository, filePath), contents)
	}

	run("init", "--quiet", "--initial-branch", "main")
	run("config", "user.email", "gate@example.com")
	run("config", "user.name", "Gate")
	run("config", "commit.gpgsign", "false")

	write("packages/core/src/unrelated.ts", "export const unrelated = () => 1\n")
	write("packages/core/src/feature.ts", "export const feature = () => 1\n")
	run("add", ".")
	run("commit", "--quiet", "-m", "initial")
	const eventBaseSha = run("rev-parse", "HEAD")

	run("checkout", "--quiet", "-b", "pull-request")
	write("packages/core/src/feature.ts", "export const feature = () => 2\n")
	run("add", ".")
	run("commit", "--quiet", "-m", "pull request change")

	// The upstream change lands after the pull_request event recorded its base SHA, which is what
	// made the stale event base attribute unrelated main-only lines to the pull request.
	run("checkout", "--quiet", "main")
	write("packages/core/src/unrelated.ts", "export const unrelated = () => 99\n")
	run("add", ".")
	run("commit", "--quiet", "-m", "unrelated upstream change")
	const upstreamSha = run("rev-parse", "HEAD")

	run("merge", "--quiet", "--no-ff", "-m", "merge pull request", "pull-request")
	const mergeSha = run("rev-parse", "HEAD")

	return { repository, eventBaseSha, upstreamSha, mergeSha }
}

describe("pull request revision selection", () => {
	it("excludes unrelated upstream files by diffing from the merge commit's first parent", () => {
		const { repository, eventBaseSha, upstreamSha, mergeSha } = createSyntheticPullRequestRepository()

		// A failed assertion must still remove the temporary repository, or a failing run leaks it.
		try {
			const manifest = selectFromGit(repository, eventBaseSha, mergeSha)
			const changedPaths = manifest.packages.flatMap((entry) => entry.files.map((file) => file.path))

			assert.deepEqual(changedPaths, ["packages/core/src/feature.ts"])
			assert.equal(manifest.baseSha, upstreamSha)
			assert.equal(manifest.mergeBase, upstreamSha)

			// Selectors must stay aligned with the checked-out head content.
			assert.equal(manifest.headSha, mergeSha)
			assert.deepEqual(
				manifest.packages.flatMap((entry) => entry.selectors),
				["src/feature.ts:1-1"],
			)
		} finally {
			fs.rmSync(repository, { recursive: true, force: true })
		}
	})

	it("keeps the supplied base for non-merge heads such as manual runs", () => {
		const { repository, eventBaseSha, upstreamSha } = createSyntheticPullRequestRepository()

		try {
			const manifest = selectFromGit(repository, eventBaseSha, upstreamSha)

			assert.equal(manifest.baseSha, eventBaseSha)
			assert.equal(manifest.mergeBase, eventBaseSha)
			assert.deepEqual(
				manifest.packages.flatMap((entry) => entry.files.map((file) => file.path)),
				["packages/core/src/unrelated.ts"],
			)
		} finally {
			fs.rmSync(repository, { recursive: true, force: true })
		}
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
			"packages/types/src/changed.ts": "export const changed = (value: boolean) => (value ? 1 : 2)\n",
		}
		const diffs = {
			"packages/core/src/changed.ts": "@@ -1,2 +1,2 @@\n",
			"webview-ui/src/utils/changed.ts": "@@ -1 +1 @@\n",
			"src/utils/changed.ts": "@@ -1 +1 @@\n",
			"packages/types/src/changed.ts": "@@ -1 +1 @@\n",
		}
		const manifest = buildManifest(
			[
				{ status: "M", path: "packages/core/src/changed.ts" },
				{ status: "A", path: "packages/cloud/src/new.ts" },
				{ status: "M", path: "webview-ui/src/utils/changed.ts" },
				{ status: "M", path: "src/utils/changed.ts" },
				{ status: "M", path: "packages/types/src/changed.ts" },
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
				{ id: "types", selectors: ["src/changed.ts:1-1"] },
			],
		)
		const webview = manifest.packages.find(({ id }) => id === "webview")
		const extension = manifest.packages.find(({ id }) => id === "extension")
		assert.equal(webview.runRoot, ".")
		assert.equal(webview.discoverRelatedTests, true)
		assert.equal(webview.vitestRelated, false)
		// The extension package deliberately uses plugin-side discovery (see the
		// comment in PACKAGE_CONFIGS): stryker-js 10.0.0 mis-activates static mutants
		// when an explicit STRYKER_TEST_FILES list is supplied.
		assert.equal(extension.discoverRelatedTests, false)
		assert.equal(extension.vitestRelated, true)
		const types = manifest.packages.find(({ id }) => id === "types")
		assert.equal(types.discoverRelatedTests, undefined)
		assert.equal(types.vitestRelated, undefined)
	})

	it("returns no packages for tests, barrels, unsupported packages, and type-only changes", () => {
		const manifest = buildManifest(
			[
				{ status: "M", path: "packages/core/src/index.ts" },
				{ status: "M", path: "packages/core/src/value.spec.ts" },
				{ status: "M", path: "webview-ui/src/value.visual.tsx" },
				{ status: "M", path: "webview-ui/src/main.tsx" },
				{ status: "M", path: "src/utils/vitest-verbosity.ts" },
				{ status: "M", path: "src/scripts/merge-lcov.mjs" },
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

		assert.deepEqual(manifest, { packages: [], advisories: [] })
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

	it("reports invalid mutation exclusions without bypassing executable-line accounting", () => {
		const manifest = buildManifest(
			[{ status: "A", path: "packages/core/src/value.ts" }],
			() => "// Stryker disable next-line all: noisy\nexport const value = true\n",
			() => "",
		)

		assert.equal(manifest.packages[0].changedExecutableLines, 1)
		assert.match(manifest.advisories.join("\n"), /broad or unreasoned exclusions are not allowed/)
	})
})

describe("packageForPath", () => {
	it("routes webview, extension, and types production code while excluding test infrastructure", () => {
		assert.equal(packageForPath("webview-ui/src/utils/path-mentions.ts").id, "webview")
		assert.equal(packageForPath("src/utils/tool-id.ts").id, "extension")
		assert.equal(packageForPath("packages/types/src/global-settings.ts").id, "types")
		assert.equal(packageForPath("packages/types/src/__tests__/global-settings.test.ts"), undefined)
		assert.equal(packageForPath("webview-ui/src/utils/test-utils.ts"), undefined)
		assert.equal(packageForPath("src/__mocks__/vscode.js"), undefined)
		assert.equal(packageForPath("apps/vscode-e2e/src/example.ts"), undefined)
	})
})

describe("parseVitestTestFiles", () => {
	it("normalizes and deduplicates all Vitest related-test results without filename filtering", () => {
		assert.deepEqual(
			parseVitestTestFiles(
				{
					testResults: [
						{ name: "/repo/webview-ui/src/utils/__tests__/value.test.ts" },
						{ name: "/repo/webview-ui/src/utils/__tests__/value.test.ts" },
						{ name: "/repo/webview-ui/src/components/__tests__/consumer-named.spec.tsx" },
					],
				},
				"/repo",
			),
			[
				"webview-ui/src/utils/__tests__/value.test.ts",
				"webview-ui/src/components/__tests__/consumer-named.spec.tsx",
			],
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

	it("matches direct tests case-insensitively with dot and hyphen suffixes", () => {
		const related = [
			"core/task/__tests__/Task.persistence.spec.ts",
			"core/tools/__tests__/attemptCompletionTool.spec.ts",
			"extension/__tests__/api-task-conversation-history-length.spec.ts",
			"core/task/__tests__/unrelated.spec.ts",
		]

		assert.deepEqual(
			preferDirectTestFiles(related, [
				"core/task/Task.ts",
				"core/tools/AttemptCompletionTool.ts",
				"extension/api.ts",
			]),
			related.slice(0, 3),
		)
	})

	it("keeps all related tests when any changed source lacks a direct test", () => {
		const related = ["src/__tests__/indirect-a.spec.ts", "src/__tests__/B.spec.ts"]

		assert.deepEqual(preferDirectTestFiles(related, ["src/A.ts", "src/B.ts"]), related)
	})
})

describe("shouldUseVitestRelated", () => {
	it("does not re-filter an explicit discovered test list", () => {
		assert.equal(shouldUseVitestRelated({ testFiles: ["focused.spec.ts"] }), false)
		assert.equal(shouldUseVitestRelated({ testFiles: [], vitestRelated: true }), true)
		assert.equal(shouldUseVitestRelated({ vitestRelated: false }), false)
		assert.equal(shouldUseVitestRelated({ testFiles: [] }), true)
	})
})

describe("related-test discovery", () => {
	it("keeps Stryker's temp directory relative to each run root", () => {
		assert.equal(resolveStrykerTempDir("/repo", "/repo"), ".stryker-tmp")
		assert.equal(resolveStrykerTempDir("/repo", "/repo/src"), path.join("..", ".stryker-tmp"))
	})

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

describe("Stryker configuration", () => {
	it("uses the default or configured temp directory", async () => {
		const originalTempDir = process.env.STRYKER_TEMP_DIR
		const configUrl = pathToFileURL(path.join(repositoryRoot, "stryker.config.mjs"))

		try {
			delete process.env.STRYKER_TEMP_DIR
			const defaultConfig = (await import(`${configUrl.href}?temp-dir=default`)).default
			assert.equal(defaultConfig.tempDirName, ".stryker-tmp")

			process.env.STRYKER_TEMP_DIR = path.join("..", ".stryker-tmp")
			const configuredConfig = (await import(`${configUrl.href}?temp-dir=configured`)).default
			assert.equal(configuredConfig.tempDirName, path.join("..", ".stryker-tmp"))
		} finally {
			if (originalTempDir === undefined) delete process.env.STRYKER_TEMP_DIR
			else process.env.STRYKER_TEMP_DIR = originalTempDir
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

	it("uses merge-result line coordinates when the base shifts a pull request edit", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-merge-diff-"))
		const runGit = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()

		try {
			runGit("init", "--initial-branch=main")
			runGit("config", "user.name", "Mutation Test")
			runGit("config", "user.email", "mutation@example.com")
			fs.mkdirSync(path.join(repo, "packages/core/src"), { recursive: true })
			fs.writeFileSync(path.join(repo, "packages/core/src/value.ts"), "const first = 1\nconst changed = true\n")
			runGit("add", ".")
			runGit("commit", "-m", "initial")

			runGit("checkout", "-b", "feature")
			fs.writeFileSync(path.join(repo, "packages/core/src/value.ts"), "const first = 1\nconst changed = false\n")
			runGit("commit", "-am", "change value")

			runGit("checkout", "main")
			fs.writeFileSync(
				path.join(repo, "packages/core/src/value.ts"),
				"const inserted = 0\nconst first = 1\nconst changed = true\n",
			)
			runGit("commit", "-am", "shift source lines")
			const baseSha = runGit("rev-parse", "HEAD")
			runGit("merge", "--no-ff", "feature", "-m", "merge feature")
			const mergeSha = runGit("rev-parse", "HEAD")

			const manifest = selectFromGit(repo, baseSha, mergeSha)
			assert.deepEqual(
				manifest.packages.map(({ id, selectors }) => ({ id, selectors })),
				[{ id: "core", selectors: ["src/value.ts:3-3"] }],
			)
		} finally {
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("does not charge intervening base-branch changes to the pull request", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-stale-base-"))
		const runGit = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()

		try {
			runGit("init", "--initial-branch=main")
			runGit("config", "user.name", "Mutation Test")
			runGit("config", "user.email", "mutation@example.com")
			fs.mkdirSync(path.join(repo, "packages/core/src"), { recursive: true })
			fs.writeFileSync(path.join(repo, "packages/core/src/pr.ts"), "export const pr = false\n")
			fs.writeFileSync(path.join(repo, "packages/core/src/base.ts"), "export const base = false\n")
			runGit("add", ".")
			runGit("commit", "-m", "initial")
			const staleBaseSha = runGit("rev-parse", "HEAD")

			runGit("checkout", "-b", "feature")
			fs.writeFileSync(path.join(repo, "packages/core/src/pr.ts"), "export const pr = true\n")
			runGit("commit", "-am", "change pull request")

			runGit("checkout", "main")
			fs.writeFileSync(path.join(repo, "packages/core/src/base.ts"), "export const base = true\n")
			runGit("commit", "-am", "advance base branch")
			const currentBaseSha = runGit("rev-parse", "HEAD")
			runGit("merge", "--no-ff", "feature", "-m", "synthetic pull request merge")
			const mergeSha = runGit("rev-parse", "HEAD")
			const mergeResultBaseSha = runGit("rev-parse", `${mergeSha}^1`)
			assert.equal(mergeResultBaseSha, currentBaseSha)

			// A stale base is normalized to the merge's first parent, so the advanced base branch
			// file is not charged to the pull request.
			assert.deepEqual(
				selectFromGit(repo, staleBaseSha, mergeSha).packages[0].files.map(({ path: filePath }) => filePath),
				["packages/core/src/pr.ts"],
			)
			assert.deepEqual(
				selectFromGit(repo, mergeResultBaseSha, mergeSha).packages[0].files.map(
					({ path: filePath }) => filePath,
				),
				["packages/core/src/pr.ts"],
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

	it("lists every advisory mutant with tests, reproduction, exclusion, and report guidance", () => {
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
					result: "Advisory findings",
				},
			],
			["extension has advisory mutants"],
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
		assert.ok(summary.includes("### Advisory findings"))
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

	it("emits one distinguishable annotation per source location", () => {
		const mutants = [
			blocking[2],
			blocking[1],
			{
				filePath: "utils/other.ts",
				status: "NoCoverage",
				mutatorName: "ConditionalExpression",
				replacement: "true",
				location: { start: { line: 9 } },
			},
			blocking[0],
		]
		const originalOrder = [...mutants]
		const annotations = formatAnnotations(mutants, "src")

		assert.equal(annotations.length, 2)
		assert.deepEqual(mutants, originalOrder)
		assert.match(
			annotations[0].message,
			/^src\/core\/value\.ts:4: 2 mutation test gaps; example: NoCoverage StringLiteral mutant \(replacement: "left \| right"\)/,
		)
		assert.match(
			annotations[1].message,
			/^src\/utils\/other\.ts:9: 2 mutation test gaps; example: Survived BooleanLiteral mutant \(replacement: false\)/,
		)
	})

	it("prefixes singleton annotations with their source location", () => {
		const [annotation] = formatAnnotations([blocking[2]], "src")

		assert.equal(
			annotation.message,
			"src/utils/other.ts:9: Survived BooleanLiteral mutant (replacement: false). See the job summary for the complete list and resolution guidance.",
		)
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
			"::warning file=src/value%3Aone%2Ctwo.ts,line=4,title=Mutation test advisory::Survived mutant (replacement: left, right). 100%25 reproducible.",
		)
	})

	it("escapes aggregated advisory warnings", () => {
		assert.equal(
			formatAdvisoryCommand("preflight failed: 100%\nretry"),
			"::warning title=Mutation test advisory::preflight failed: 100%25%0Aretry",
		)
	})

	it("reports a Stryker preflight launch error when the binary is missing", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-launch-"))
		const reportRoot = path.join(repo, "reports")

		try {
			fs.mkdirSync(path.join(repo, "packages/core"), { recursive: true })
			assert.doesNotThrow(() =>
				runManifest(
					repo,
					{
						packages: [
							{
								id: "core",
								root: "packages/core",
								vitestConfig: "vitest.unit.config.ts",
								selectors: ["src/value.ts:1-1"],
								changedExecutableLines: 1,
							},
						],
					},
					reportRoot,
				),
			)
		} finally {
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("classifies successful package rows from blocking mutants", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-success-"))
		const packageEntry = {
			id: "core",
			root: "packages/core",
			vitestConfig: "vitest.unit.config.ts",
			selectors: ["src/value.ts:1-1"],
			changedExecutableLines: 1,
		}
		const execute = (report) =>
			runManifest(repo, { packages: [{ ...packageEntry }] }, path.join(repo, "reports"), {
				runMutation: (_repoRoot, _entry, _reportRoot, dryRunOnly) =>
					dryRunOnly ? "Instrumented 1 source file(s) with 1 mutant(s)" : "",
				readMutationReport: () => report,
			})[0]

		try {
			const advisoryRow = execute({
				files: {
					"src/value.ts": {
						mutants: [
							{
								status: "Survived",
								mutatorName: "BooleanLiteral",
								replacement: "false",
								location: { start: { line: 1 } },
							},
						],
					},
				},
			})
			assert.equal(advisoryRow.result, "Advisory findings")
			assert.deepEqual(advisoryRow.advisories, [])

			const passedRow = execute({
				files: { "src/value.ts": { mutants: [{ status: "Killed", location: { start: { line: 1 } } }] } },
			})
			assert.equal(passedRow.result, "Passed")
			assert.deepEqual(passedRow.advisories, [])
		} finally {
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("does not fail when the GitHub job summary cannot be written", () => {
		const previousSummary = process.env.GITHUB_STEP_SUMMARY
		const summaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-summary-"))
		process.env.GITHUB_STEP_SUMMARY = summaryDirectory

		try {
			assert.doesNotThrow(() => appendSummary([], ["advisory"], {}))
		} finally {
			if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY
			else process.env.GITHUB_STEP_SUMMARY = previousSummary
			fs.rmSync(summaryDirectory, { recursive: true, force: true })
		}
	})

	it("emits aggregated warnings when the GitHub job summary is unavailable", () => {
		const previousSummary = process.env.GITHUB_STEP_SUMMARY
		const previousWarn = console.warn
		const warnings = []
		delete process.env.GITHUB_STEP_SUMMARY
		console.warn = (warning) => warnings.push(warning)

		try {
			appendSummary([], ["manifest invalid\nreview it"], {})
			assert.deepEqual(warnings, ["::warning title=Mutation test advisory::manifest invalid%0Areview it"])
		} finally {
			if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY
			else process.env.GITHUB_STEP_SUMMARY = previousSummary
			console.warn = previousWarn
		}
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
			result: "Advisory findings",
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

	it("reports surviving and uncovered mutants through detailed annotations without a redundant aggregate", () => {
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

		const result = evaluateReport(report, packageEntry)
		assert.deepEqual(result.advisories, [])
		assert.equal(formatAnnotations(mutantCounts(report).blocking, packageEntry.root).length, 2)
	})

	it("has no advisories for killed or limited timed-out mutants within the cap", () => {
		const mutants = Array.from({ length: MAX_MUTANTS }, (_, index) => ({
			status: index === 0 ? "Timeout" : "Killed",
			location: { start: { line: index + 1 } },
		}))
		const counts = evaluateReport({ files: { "src/value.ts": { mutants } } }, packageEntry)
		assert.equal(counts.valid, MAX_MUTANTS)
		assert.deepEqual(counts.advisories, [])
	})

	it("reports valid mutants over the cap as advisory", () => {
		const mutants = Array.from({ length: MAX_MUTANTS + 1 }, (_, index) => ({
			status: "Killed",
			location: { start: { line: index + 1 } },
		}))
		assert.match(
			evaluateReport({ files: { "src/value.ts": { mutants } } }, packageEntry).advisories.join("\n"),
			/split the PR or obtain a maintainer-reviewed narrow exclusion/i,
		)
	})

	it("reports excessive timeouts as advisory", () => {
		const mutants = Array.from({ length: 10 }, (_, index) => ({
			status: index < 2 ? "Timeout" : "Killed",
			location: { start: { line: index + 1 } },
		}))
		assert.match(
			evaluateReport({ files: { "src/value.ts": { mutants } } }, packageEntry).advisories.join("\n"),
			/result is inconclusive/,
		)
	})
})

describe("accepted equivalent mutants", () => {
	const packageEntry = { id: "extension", root: "src", sourceRoot: "src/" }
	const report = {
		files: {
			"utils/pathUtils.ts": {
				mutants: [
					{
						status: "Survived",
						mutatorName: "EqualityOperator",
						replacement: "<=",
						location: { start: { line: 45, column: 0 } },
					},
					{
						status: "Survived",
						mutatorName: "ConditionalExpression",
						replacement: "true",
						location: { start: { line: 50, column: 2 } },
					},
				],
			},
		},
	}
	const equivalences = [
		{
			file: "src/utils/pathUtils.ts",
			line: 45,
			column: 0,
			mutator: "EqualityOperator",
			replacement: "<=",
			reason: "defensive bound never hit",
		},
		{
			file: "src/utils/pathUtils.ts",
			line: 99,
			column: 0,
			mutator: "BlockStatement",
			replacement: "{}",
			reason: "entry whose mutant is gone",
		},
		{
			file: "src/other.ts",
			line: 7,
			column: 0,
			mutator: "Foo",
			replacement: "bar",
			reason: "file not part of this run",
		},
	]

	it("removes accepted equivalent mutants from the blocking set", () => {
		const counts = evaluateReport(report, packageEntry, equivalences)
		assert.equal(counts.equivalent, 1)
		assert.equal(counts.survived, 2)
		assert.equal(counts.blocking.length, 1)
		assert.equal(counts.blocking[0].mutatorName, "ConditionalExpression")
	})

	it("accepts only the reviewed replacement when two mutants share a key", () => {
		const twoMutants = {
			files: {
				"utils/pathUtils.ts": {
					mutants: [
						{
							status: "Survived",
							mutatorName: "ConditionalExpression",
							replacement: "true",
							location: { start: { line: 50, column: 2 } },
						},
						{
							status: "Survived",
							mutatorName: "ConditionalExpression",
							replacement: "false",
							location: { start: { line: 50, column: 2 } },
						},
					],
				},
			},
		}
		const reviewed = [
			{
				file: "src/utils/pathUtils.ts",
				line: 50,
				column: 2,
				mutator: "ConditionalExpression",
				replacement: "true",
				reason: "only the true replacement is equivalent here",
			},
		]
		const counts = evaluateReport(twoMutants, packageEntry, reviewed)
		assert.equal(counts.equivalent, 1)
		assert.equal(counts.blocking.length, 1)
		assert.equal(counts.blocking[0].replacement, "false")
	})

	it("limits each registry entry to a single accepted mutant", () => {
		// A compound condition emits several ConditionalExpression/true mutants on one line that
		// differ only by column. One reviewed entry must not accept all of them.
		const threeSameKey = {
			files: {
				"utils/pathUtils.ts": {
					mutants: [1, 2, 3].map((column) => ({
						status: "Survived",
						mutatorName: "ConditionalExpression",
						replacement: "true",
						location: { start: { line: 50, column } },
					})),
				},
			},
		}
		const oneEntry = [
			{
				file: "src/utils/pathUtils.ts",
				line: 50,
				column: 1,
				mutator: "ConditionalExpression",
				replacement: "true",
				reason: "the first sub-expression is equivalent here",
			},
		]
		const limited = evaluateReport(threeSameKey, packageEntry, oneEntry)
		assert.equal(limited.equivalent, 1)
		assert.equal(limited.blocking.length, 2)
		assert.deepEqual(
			limited.blocking.map((mutant) => mutant.location.start.column),
			[2, 3],
		)
		assert.deepEqual(limited.advisories, [])

		const twoEntries = [
			...oneEntry,
			{ ...oneEntry[0], column: 2, reason: "the second sub-expression is also equivalent" },
		]
		const both = evaluateReport(threeSameKey, packageEntry, twoEntries)
		assert.equal(both.equivalent, 2)
		assert.equal(both.blocking.length, 1)
		assert.deepEqual(both.advisories, [])
	})

	it("flags registry duplicates that no extra mutant consumed", () => {
		const singleMutant = {
			files: {
				"utils/pathUtils.ts": {
					mutants: [
						{
							status: "Survived",
							mutatorName: "ConditionalExpression",
							replacement: "true",
							location: { start: { line: 50, column: 1 } },
						},
					],
				},
			},
		}
		const oneEntry = {
			file: "src/utils/pathUtils.ts",
			line: 50,
			column: 1,
			mutator: "ConditionalExpression",
			replacement: "true",
			reason: "only one mutant carries this key",
		}
		const counts = evaluateReport(singleMutant, packageEntry, [
			oneEntry,
			{ ...oneEntry, reason: "duplicate entry with no second mutant to accept" },
		])
		assert.equal(counts.equivalent, 1)
		assert.equal(counts.unusedEquivalences.length, 1)
		assert.equal(counts.unusedEquivalences[0].reason, "duplicate entry with no second mutant to accept")
	})

	it("advises about stale entries only for files present in the report", () => {
		const advisories = evaluateReport(report, packageEntry, equivalences).advisories.join("\n")
		assert.match(advisories, /src\/utils\/pathUtils\.ts:99:BlockStatement/)
		assert.doesNotMatch(advisories, /src\/other\.ts/)
	})

	it("keeps prior behavior when no equivalences are configured", () => {
		const counts = evaluateReport(report, packageEntry)
		assert.equal(counts.blocking.length, 2)
		assert.equal(counts.equivalent, 0)
	})

	it("applies registry equivalences through the runManifest pipeline", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-equiv-manifest-"))
		const packageEntry = {
			id: "core",
			root: "packages/core",
			sourceRoot: "packages/core/",
			vitestConfig: "vitest.unit.config.ts",
			selectors: ["src/value.ts:1-1"],
			changedExecutableLines: 1,
		}
		try {
			const row = runManifest(repo, { packages: [{ ...packageEntry }] }, path.join(repo, "reports"), {
				runMutation: (_repoRoot, _entry, _reportRoot, dryRunOnly) =>
					dryRunOnly ? "Instrumented 1 source file(s) with 1 mutant(s)" : "",
				readMutationReport: () => ({
					files: {
						"src/value.ts": {
							mutants: [
								{
									status: "Survived",
									mutatorName: "BooleanLiteral",
									replacement: "false",
									location: { start: { line: 1 } },
								},
							],
						},
					},
				}),
				readEquivalences: () => [
					{
						file: "packages/core/src/value.ts",
						line: 1,
						mutator: "BooleanLiteral",
						replacement: "false",
						reason: "the mutated branch is unreachable in every caller",
					},
				],
			})[0]
			assert.equal(row.equivalent, 1)
			assert.equal(row.result, "Passed")
			assert.deepEqual(row.advisories, [])
		} finally {
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("loads no equivalences when the registry file is absent", (t) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-eq-"))
		t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
		assert.deepEqual(loadEquivalences(directory), [])
	})

	it("loads entries from a repository registry file", (t) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-eq-present-"))
		t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
		fs.mkdirSync(path.join(directory, "scripts"), { recursive: true })
		const entry = {
			file: "src/example.ts",
			line: 3,
			column: 2,
			mutator: "ConditionalExpression",
			replacement: "true",
			reason: "example reason that is long enough to be reviewable",
		}
		fs.writeFileSync(
			path.join(directory, "scripts/stryker-equivalences.json"),
			JSON.stringify({ equivalences: [entry] }),
			"utf8",
		)

		assert.deepEqual(loadEquivalences(directory), [entry])
	})

	it("ships registry entries with file, line, mutator, and reason", () => {
		const registry = JSON.parse(
			fs.readFileSync(path.join(repositoryRoot, "scripts/stryker-equivalences.json"), "utf8"),
		).equivalences
		assert.ok(registry.length > 0)
		for (const entry of registry) {
			assert.match(entry.file, /^(src|packages)\//)
			assert.ok(Number.isInteger(entry.line))
			assert.ok(Number.isInteger(entry.column) && entry.column >= 0)
			assert.ok(entry.mutator)
			assert.equal(typeof entry.replacement, "string")
			assert.ok(entry.reason.length > 20)
			// The node fingerprint binds the entry to the exact AST node, so a same-line edit that
			// leaves a different expression cannot silently re-bind the accepted equivalence.
			assert.equal(typeof entry.node, "string")
			assert.ok(entry.node.length > 0)
		}
	})

	it("rejects an entry whose line does not hold the named mutator", () => {
		const source = ["const a = 1", "const b = a === 2 ? 3 : 4", "const c = { once: true }", ""].join("\n")
		const readSource = () => source
		const conditional = {
			file: "src/example.ts",
			line: 1,
			column: 10,
			mutator: "ConditionalExpression",
			replacement: "true",
			reason: "example",
		}

		// Report lines are 0-based: line 1 is the ternary on editor line 2.
		assert.deepEqual(validateEquivalenceEntries([conditional], readSource), [])

		// The object literal is on editor line 3, so report line 2, not 1.
		const driftedObject = { ...conditional, mutator: "ObjectLiteral", line: 1 }
		assert.match(
			validateEquivalenceEntries([driftedObject], readSource).join("\n"),
			/src\/example\.ts:1:10: expected ObjectLiteral code at line 2/,
		)

		// ConditionalExpression is a different node kind than the object literal.
		const driftedConditional = { ...conditional, line: 2 }
		assert.match(
			validateEquivalenceEntries([driftedConditional], readSource).join("\n"),
			/expected ConditionalExpression code at line 3/,
		)

		// A same-line edit that moves the mutated node must invalidate the entry rather than
		// silently accepting whatever mutant now sits on the recorded line.
		const driftedColumn = { ...conditional, column: 11 }
		assert.match(
			validateEquivalenceEntries([driftedColumn], readSource).join("\n"),
			/src\/example\.ts:1:11: expected ConditionalExpression code at line 2/,
		)
	})

	it("rejects a CallExpression entry whose recorded column now holds only an identifier", () => {
		// A registered call edited from outer(inner(arg)) to outer(arg) leaves the identifier
		// arg at the removed inner call's former column. Descendant-column matching is only for
		// condition-shaped mutators, so an identifier must not validate a CallExpression entry.
		const sourceBefore = "const y = outer(inner(arg))\n"
		const sourceAfter = "const y = outer(arg)\n"
		const entry = {
			file: "src/example.ts",
			line: 0,
			column: 16,
			mutator: "CallExpression",
			replacement: "undefined",
			reason: "example",
		}

		assert.deepEqual(
			validateEquivalenceEntries([entry], () => sourceBefore),
			[],
		)
		assert.match(
			validateEquivalenceEntries([entry], () => sourceAfter).join("\n"),
			/src\/example\.ts:0:16: expected CallExpression code at line 1/,
		)
	})

	it("rejects an entry with an unknown mutator or missing file", () => {
		const source = "const a = 1\n"
		const unknown = { file: "src/example.ts", line: 0, mutator: "NotAMutator", replacement: "x", reason: "example" }
		const problems = validateEquivalenceEntries([unknown], () => source)
		assert.match(problems.join("\n"), /unknown mutator NotAMutator/)

		const missing = { ...unknown, mutator: "ConditionalExpression", file: "src/missing.ts" }
		assert.match(
			validateEquivalenceEntries([missing], () => undefined).join("\n"),
			/src\/missing\.ts: file not found/,
		)
	})

	it("rejects an entry with a missing or negative start column", () => {
		const source = "const a = 1\nconst b = a === 2 ? 3 : 4\n"
		const base = {
			file: "src/example.ts",
			line: 1,
			column: 10,
			mutator: "ConditionalExpression",
			replacement: "true",
			reason: "example",
		}

		const missing = { ...base }
		delete missing.column
		assert.match(
			validateEquivalenceEntries([missing], () => source).join("\n"),
			/src\/example\.ts:1: missing start column/,
		)

		const negative = { ...base, column: -1 }
		assert.match(
			validateEquivalenceEntries([negative], () => source).join("\n"),
			/src\/example\.ts:1: missing start column/,
		)
	})

	it("rejects an entry whose node fingerprint does not match the current AST node", () => {
		const source = "const a = 1\nconst b = a === 2 ? 3 : 4\n"
		const entry = {
			file: "src/example.ts",
			line: 1,
			column: 10,
			mutator: "ConditionalExpression",
			replacement: "true",
			reason: "example",
			node: "a !== 2 ? 3 : 4",
		}
		assert.match(
			validateEquivalenceEntries([entry], () => source).join("\n"),
			/node fingerprint mismatch for ConditionalExpression/,
		)
	})

	it("validates every shipped registry entry against the checked-in head", () => {
		const equivalences = loadEquivalences(repositoryRoot)
		assert.ok(equivalences.length > 0)
		assert.deepEqual(
			validateEquivalenceEntries(equivalences, (file) => {
				const filePath = path.join(repositoryRoot, file)
				return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined
			}),
			[],
		)
	})

	it("reports the equivalent column in the summary", () => {
		const summary = formatSummary(
			[
				{
					id: "extension",
					root: "src",
					changedLines: 1,
					valid: 2,
					killed: 1,
					timeout: 0,
					survived: 1,
					noCoverage: 0,
					equivalent: 1,
					result: "Passed",
					testFiles: [],
				},
			],
			[],
			{},
		)
		const header = summary.split("\n").find((line) => line.includes("| Equivalent |")) ?? ""
		const delimiter = summary.split("\n")[summary.split("\n").indexOf(header) + 1] ?? ""
		assert.equal(header.split("|").length, delimiter.split("|").length)
		assert.ok(summary.includes("| Equivalent |"))
		assert.ok(summary.includes("| 1 | Passed |"))
	})
})

describe("focused test reporting", () => {
	const row = {
		id: "core",
		root: "packages/core",
		reportPath: "reports/mutation/core/mutation.html",
		changedLines: 1,
		valid: 1,
		killed: 1,
		timeout: 0,
		survived: 0,
		noCoverage: 0,
	}
	for (const [result, expected] of [
		["Passed", "Selected test file names were not recorded in the mutation report."],
		["Advisory findings", "Selected test file names were not recorded in the mutation report."],
		["No mutants generated", "No mutants were generated; selected test file names were not recorded."],
		[
			"Advisory incomplete",
			"The mutation run was incomplete; selected test file names were not recorded. See Advisory findings for the failure.",
		],
	]) {
		it(`reports missing test metadata accurately for ${result}`, () => {
			const summary = formatSummary([{ ...row, result, testFiles: [] }], [])
			assert.ok(summary.includes(`- **core** (cwd \`packages/core\`): ${expected}`))
			assert.equal(summary.includes("run was incomplete"), result === "Advisory incomplete")
		})
	}
	it("lists recorded test files even when a later mutation phase fails", () => {
		const summary = formatSummary([{ ...row, result: "Advisory incomplete", testFiles: ["src/value.test.ts"] }], [])
		assert.ok(summary.includes("- **core** (cwd `packages/core`): `src/value.test.ts`"))
		assert.ok(!summary.includes("test file names were not recorded"))
	})
})

describe("PR comment file", () => {
	const headSha = "d".repeat(40)
	const manifest = { baseSha: "c".repeat(40), headSha }
	const survivedMutant = {
		filePath: "src/value.ts",
		status: "Survived",
		mutatorName: "BooleanLiteral",
		replacement: "false",
		location: { start: { line: 4 } },
	}
	const advisoryRow = {
		id: "core",
		root: "packages/core",
		selectors: ["src/value.ts:4-4"],
		testFiles: [],
		reportPath: "reports/mutation/core/mutation.html",
		changedLines: 1,
		valid: 3,
		killed: 1,
		timeout: 0,
		survived: 1,
		noCoverage: 0,
		blocking: [survivedMutant],
		result: "Advisory findings",
	}

	it("formats the hidden marker, validated counts, and the job summary for the comment", () => {
		const comment = formatPrComment([advisoryRow], ["manifest advisory"], manifest)
		const lines = comment.split("\n")

		assert.equal(lines[0], PR_COMMENT_MARKER)
		assert.equal(lines[1], `<!-- zoo-code-mutation-report head:${headSha} blocking:1 advisories:1 -->`)
		assert.ok(comment.includes("#### `packages/core/src/value.ts`"))
		assert.ok(comment.includes("| 4 | Survived | BooleanLiteral | false |"))
		assert.ok(comment.includes("### Resolve a mutation gap"))
		assert.ok(comment.includes("### Advisory findings"))
	})

	it("uses the PR head for provenance while retaining the merge SHA for reproduction", () => {
		const previous = process.env.PR_HEAD_SHA
		const prHead = "a".repeat(40)
		process.env.PR_HEAD_SHA = prHead
		try {
			const comment = formatPrComment([advisoryRow], [], manifest)
			assert.ok(comment.includes(`head:${prHead} blocking:1`))
			assert.ok(comment.includes(`--head ${manifest.headSha}`))
		} finally {
			if (previous === undefined) delete process.env.PR_HEAD_SHA
			else process.env.PR_HEAD_SHA = previous
		}
	})

	it("falls back to the analyzed SHA when PR_HEAD_SHA is empty", () => {
		const previous = process.env.PR_HEAD_SHA
		process.env.PR_HEAD_SHA = ""
		try {
			assert.ok(formatPrComment([], [], manifest).includes(`head:${headSha} blocking:0`))
		} finally {
			if (previous === undefined) delete process.env.PR_HEAD_SHA
			else process.env.PR_HEAD_SHA = previous
		}
	})

	it("counts zero survivors for clean runs", () => {
		const passedRow = { ...advisoryRow, blocking: [], survived: 0, result: "Passed" }
		const lines = formatPrComment([passedRow], [], manifest).split("\n")

		assert.equal(lines[1], `<!-- zoo-code-mutation-report head:${headSha} blocking:0 advisories:0 -->`)
	})

	it("refuses to format a comment without a full head SHA to validate provenance", () => {
		assert.equal(formatPrComment([advisoryRow], [], {}), undefined)
		assert.equal(formatPrComment([advisoryRow], [], { headSha: "abc123" }), undefined)
	})

	it("writes the comment file without requiring a GitHub job summary", () => {
		const commentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-pr-comment-"))
		const commentFile = path.join(commentDirectory, "nested", PR_COMMENT_FILENAME)
		const previousSummary = process.env.GITHUB_STEP_SUMMARY
		delete process.env.GITHUB_STEP_SUMMARY

		try {
			appendSummary([advisoryRow], ["manifest advisory"], manifest, commentFile)
			const lines = fs.readFileSync(commentFile, "utf8").split("\n")
			assert.equal(lines[0], PR_COMMENT_MARKER)
			assert.equal(lines[1], `<!-- zoo-code-mutation-report head:${headSha} blocking:1 advisories:1 -->`)
			assert.ok(lines.join("\n").includes("### Resolve a mutation gap"))
		} finally {
			if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY
			else process.env.GITHUB_STEP_SUMMARY = previousSummary
			fs.rmSync(commentDirectory, { recursive: true, force: true })
		}
	})

	it("skips the comment file when no head SHA can be validated", () => {
		const commentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-pr-comment-"))
		const commentFile = path.join(commentDirectory, PR_COMMENT_FILENAME)

		try {
			appendSummary([advisoryRow], [], {}, commentFile)
			assert.equal(fs.existsSync(commentFile), false)
		} finally {
			fs.rmSync(commentDirectory, { recursive: true, force: true })
		}
	})

	it("warns without failing when the comment file cannot be written", () => {
		const commentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-pr-comment-"))
		const directoryPath = path.join(commentDirectory, "occupied")
		fs.mkdirSync(directoryPath)
		const previousWarn = console.warn
		const warnings = []
		console.warn = (...args) => warnings.push(args.join(" "))

		try {
			assert.doesNotThrow(() => appendSummary([advisoryRow], [], manifest, directoryPath))
			assert.ok(warnings.some((warning) => warning.includes("Could not write the mutation PR comment file")))
		} finally {
			console.warn = previousWarn
			fs.rmSync(commentDirectory, { recursive: true, force: true })
		}
	})
})

describe("mutation PR comment workflow", () => {
	const readCommentWorkflow = () =>
		fs.readFileSync(path.join(repositoryRoot, ".github/workflows/mutation-pr-comment.yml"), "utf8")

	it("only trusts completed runs of the mutation workflow and never checks out PR code", () => {
		const workflow = readCommentWorkflow()

		assert.ok(workflow.includes('workflows: ["Changed-code mutation testing"]'))
		assert.ok(workflow.includes("types: [completed]"))
		assert.ok(workflow.includes("if: github.event.workflow_run.event == 'pull_request'"))
		assert.ok(!workflow.includes("pull_request_target"))
		assert.ok(!workflow.includes("pull_request:"))
		assert.ok(!workflow.includes("actions/checkout"))
		assert.ok(!workflow.includes("repository:"))
	})

	it("grants write access only to the per-PR comment shards", () => {
		const workflow = readCommentWorkflow()

		assert.ok(workflow.includes("permissions:\n    contents: read"))
		assert.ok(
			workflow.includes(
				"        permissions:\n            actions: read\n            pull-requests: read\n        outputs:",
			),
		)
		assert.ok(
			workflow.includes("        permissions:\n            actions: read\n            pull-requests: write"),
		)
		assert.ok(!workflow.includes("contents: write"))
		assert.ok(workflow.includes("actions/download-artifact@"))
		assert.ok(workflow.includes("run-id: ${{ github.event.workflow_run.id }}"))
	})

	it("resolves the PR number from workflow_run event data, never from the artifact", () => {
		const workflow = readCommentWorkflow()

		assert.ok(workflow.includes("run.pull_requests?.length > 0"))
		assert.ok(workflow.includes("run.head_repository?.owner?.login"))
		assert.ok(workflow.includes("pr.head?.sha === run.head_sha"))
		assert.ok(workflow.includes("pr_number: ${{ fromJSON(needs.resolve.outputs.pr_numbers) }}"))
		assert.ok(workflow.includes("PR_NUMBER: ${{ matrix.pr_number }}"))
		assert.ok(workflow.includes("GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts"))
	})

	it("validates the artifact as untrusted data before using it as a comment body", () => {
		const workflow = readCommentWorkflow()

		assert.ok(workflow.includes("fs.statSync(reportFile)"))
		assert.ok(workflow.includes("maxReportBytes"))
		assert.ok(workflow.includes("Mutation report marker mismatch"))
		assert.ok(workflow.includes("reportHeadSha !== headSha"))
		assert.ok(workflow.includes("/<!--\\s*zoo-code-mutation-report[^>]*-->/g"))
		assert.ok(workflow.includes("maxReportChars"))
	})

	it("keeps exactly one comment per PR using the shared marker and comment pattern", () => {
		const workflow = readCommentWorkflow()

		assert.ok(workflow.includes(PR_COMMENT_MARKER))
		assert.ok(workflow.includes("zoo-code-mutation-report head:"))
		assert.ok(workflow.includes("blocking:"))
		assert.ok(workflow.includes("advisories:"))
		assert.ok(workflow.includes("issues.listComments"))
		assert.ok(workflow.includes("issues.createComment"))
		assert.ok(workflow.includes("issues.updateComment"))
		assert.ok(workflow.includes("comment.user?.login === 'github-actions[bot]'"))
		assert.ok(workflow.includes("No mutants survived"))
		assert.ok(workflow.includes("group: mutation-pr-comment-${{ github.event.workflow_run.id }}"))
		assert.ok(workflow.includes("group: mutation-pr-comment-comment-${{ matrix.pr_number }}"))
	})

	it("reads the report file written by the mutation gate", () => {
		const workflow = readCommentWorkflow()
		const script = fs.readFileSync(path.join(repositoryRoot, "scripts/stryker-diff.mjs"), "utf8")

		assert.ok(script.includes(`export const PR_COMMENT_MARKER = "${PR_COMMENT_MARKER}"`))
		assert.ok(script.includes(`export const PR_COMMENT_FILENAME = "${PR_COMMENT_FILENAME}"`))
		assert.ok(workflow.includes(`mutation-report/${PR_COMMENT_FILENAME}`))
		assert.ok(script.includes("path.join(reportRoot, PR_COMMENT_FILENAME)"))
	})
})

// Execute the exact trusted inline script, rather than a copy of its logic.
// Loading a helper from the PR checkout would execute untrusted code with a write token.
describe("mutation comment execution", () => {
	it("authenticates the artifact download from the triggering workflow run", () => {
		const workflow = parseYaml(
			fs.readFileSync(path.join(repositoryRoot, ".github/workflows/mutation-pr-comment.yml"), "utf8"),
		)
		const download = workflow.jobs.comment.steps.find((step) => step.name === "Download mutation report artifact")
		assert.equal(download.with["github-token"], "${{ github.token }}")
		assert.equal(download.with["run-id"], "${{ github.event.workflow_run.id }}")
		assert.equal(download.with.name, "changed-code-mutation-report")
	})

	const head = "a".repeat(40)
	const marker = PR_COMMENT_MARKER
	const report = (content = "src/value.ts:4 Survived", counts = "blocking:1 advisories:0", sha = head) =>
		`${marker}\n<!-- zoo-code-mutation-report head:${sha} ${counts} -->\n\n${content}`

	async function execute({
		raw = report(),
		currentHead = head,
		state = "open",
		existing,
		size,
		unreadable = false,
	} = {}) {
		const workflow = parseYaml(
			fs.readFileSync(path.join(repositoryRoot, ".github/workflows/mutation-pr-comment.yml"), "utf8"),
		)
		const script = workflow.jobs.comment.steps.find((step) => step.name === "Update pull request comment").with
			.script
		const writes = []
		const warnings = []
		const github = {
			rest: {
				pulls: { get: async () => ({ data: { state, head: { sha: currentHead } } }) },
				issues: {
					listComments: () => {},
					createComment: async (value) => writes.push({ operation: "create", ...value }),
					updateComment: async (value) => writes.push({ operation: "update", ...value }),
				},
			},
			paginate: async () =>
				existing ? [{ id: 123, user: { login: "github-actions[bot]" }, body: existing }] : [],
		}
		await runInNewContext(`(async () => {${script}\n})()`, {
			github,
			context: { repo: { owner: "Zoo-Code-Org", repo: "Zoo-Code" } },
			process: { env: { PR_NUMBER: "2293", HEAD_SHA: head, TRIGGERING_RUN_URL: "https://github.com/run/1" } },
			core: { info: () => {}, warning: (message) => warnings.push(message) },
			require: (name) => {
				assert.equal(name, "fs")
				return {
					statSync: () => {
						if (unreadable) throw new Error("missing artifact")
						return { size: size ?? Buffer.byteLength(raw) }
					},
					readFileSync: () => raw,
				}
			},
		})
		return { writes, warnings }
	}

	it("publishes a matching PR head even when the analyzed merge SHA differs", async () => {
		const previous = process.env.PR_HEAD_SHA
		process.env.PR_HEAD_SHA = head
		let raw
		try {
			raw = formatPrComment([], ["example advisory"], { headSha: "b".repeat(40) })
		} finally {
			if (previous === undefined) delete process.env.PR_HEAD_SHA
			else process.env.PR_HEAD_SHA = previous
		}
		const { writes } = await execute({ raw })
		assert.equal(writes.length, 1)
		assert.equal(writes[0].operation, "create")
		assert.ok(writes[0].body.includes("example advisory"))
	})

	for (const [name, options] of [
		["wrong marker", { raw: report().replace(marker, "wrong") }],
		["malformed counts", { raw: report("text", "blocking:no advisories:0") }],
		["merge SHA instead of PR head", { raw: report("text", undefined, "b".repeat(40)) }],
		["oversized artifact", { size: 1024 * 1024 + 1 }],
		["missing artifact", { unreadable: true }],
		["outdated head", { currentHead: "c".repeat(40) }],
		["closed PR", { state: "closed" }],
	]) {
		it(`leaves an existing comment intact for ${name}`, async () => {
			const { writes } = await execute({ ...options, existing: marker })
			assert.equal(writes.length, 0)
		})
	}

	it("updates the existing bot comment and skips an identical write", async () => {
		const { writes } = await execute({ existing: marker })
		assert.equal(writes[0].operation, "update")
		assert.equal(writes[0].comment_id, 123)
		assert.equal((await execute({ existing: writes[0].body })).writes.length, 0)
	})

	it("keeps counts visible and collapses the safely escaped report by default", async () => {
		const { writes } = await execute({ raw: report("</details><img src=x>", "blocking:3 advisories:2") })
		const body = writes[0].body
		assert.ok(body.includes("| Surviving / uncovered mutants | Advisories |\n| ---: | ---: |\n| 3 | 2 |"))
		assert.ok(body.indexOf("| 3 | 2 |") < body.indexOf("<details>"))
		assert.ok(body.includes("<details>\n<summary>Details: mutants, guidance, and reproduction</summary>\n\n"))
		assert.ok(body.includes("<p>&lt;/details&gt;&lt;img src=x&gt;</p>\n\n</details>"))
		assert.equal(body.match(/<details>/g).length, 1)
		assert.equal(body.match(/<\/details>/g).length, 1)
		assert.ok(!body.includes("<details open"))
	})

	it("clears existing survivors after a clean run without creating a new clean comment", async () => {
		const raw = report("clean", "blocking:0 advisories:0")
		assert.equal((await execute({ raw })).writes.length, 0)
		const { writes } = await execute({ raw, existing: marker })
		assert.equal(writes.length, 1)
		assert.ok(writes[0].body.includes("No mutants survived"))
		assert.ok(!writes[0].body.includes("<details>"))
	})

	it("escapes hostile prose and keeps mentions and links inactive", async () => {
		const hostile = "@someone\n![image](https://example.org/track)\n<a>link</a>\n```\n" + marker + "\r\u0000end"
		const { writes } = await execute({ raw: report(hostile) })
		const body = writes[0].body
		assert.ok(
			body.includes("<p><code>@someone ![image](https://example.org/track) &lt;a&gt;link&lt;/a&gt;</code></p>"),
		)
		assert.ok(body.includes("<pre><code>end</code></pre>"))
		assert.equal(body.split(marker).length, 2)
		assert.ok(!body.includes("\r"))
		assert.ok(!body.includes("\u0000"))
	})

	it("renders headings, focused tests, guidance, and report paths as prose", async () => {
		const content = [
			"### Focused tests",
			"",
			"- **core** (cwd `packages/core`): the mutation run did not complete far enough to report its selected tests.",
			"",
			"### All surviving and uncovered mutants",
			"",
			"This summary lists every advisory mutant.",
			"",
			"### core",
			"",
			"#### `packages/core/src/value.ts`",
			"",
			"### Resolve a mutation gap",
			"",
			"Add or strengthen a focused test that fails under the mutation.",
			"",
			"```ts",
			"const result = condition ? value : fallback",
			"```",
			"",
			"### Reproduce locally",
			"",
			"From a full checkout containing both commits:",
			"",
			"```bash",
			"pnpm install --frozen-lockfile",
			"node scripts/stryker-diff.mjs ci --base abc --head def",
			"```",
			"",
			"### Mutation reports",
			"",
			"- **core:** `reports/mutation/core/mutation.html`",
			"",
			"### Advisory findings",
			"",
			"- Example advisory",
			"  continued here",
		].join("\n")
		const { writes } = await execute({ raw: report(content) })
		const body = writes[0].body
		assert.ok(body.includes("<h3>Focused tests</h3>"))
		assert.ok(body.includes("<li><strong>core</strong> (cwd <code>packages/core</code>):"))
		assert.ok(body.includes("<h4><code>packages/core/src/value.ts</code></h4>"))
		assert.ok(body.includes("<h3>Resolve a mutation gap</h3>"))
		assert.ok(body.includes("<p>Add or strengthen a focused test that fails under the mutation.</p>"))
		assert.ok(
			body.includes('<pre><code class="language-ts">const result = condition ? value : fallback</code></pre>'),
		)
		assert.ok(
			body.includes(
				'<pre><code class="language-bash">pnpm install --frozen-lockfile\nnode scripts/stryker-diff.mjs ci --base abc --head def</code></pre>',
			),
		)
		assert.ok(body.includes("<li><strong>core:</strong> <code>reports/mutation/core/mutation.html</code></li>"))
		assert.ok(body.includes("<li>Example advisory continued here</li>"))
		assert.equal(body.match(/<pre>/g).length, 2)
	})

	for (const [opener, closer] of [
		["```", "```"],
		["````", "````"],
		["~~~", "~~~"],
		["```", ""],
	]) {
		it(`keeps table syntax literal inside code fences ${opener}/${closer || "unclosed"}`, async () => {
			const content = [opener, "| Value |", "| --- |", "| </code><img> |", closer].join("\n")
			const { writes } = await execute({ raw: report(content) })
			assert.ok(writes[0].body.includes("<pre><code>| Value |\n| --- |\n| &lt;/code&gt;&lt;img&gt; |"))
			assert.ok(!writes[0].body.includes("<table>"))
			assert.ok(!writes[0].body.includes("<img>"))
		})
	}

	for (const text of [
		"@someone",
		"https://example.org",
		"www.example.org",
		"[link](/path)",
		"**@someone**",
		"`<img src=x>`",
	]) {
		it(`keeps unsafe inline content inert: ${text}`, async () => {
			const { writes } = await execute({ raw: report("### " + text + "\n\n- " + text) })
			assert.ok(writes[0].body.includes("<code>"))
			assert.ok(!writes[0].body.includes("<a "))
			assert.ok(!writes[0].body.includes("<img "))
		})
	}

	for (const reference of ["#1", "owner/repo#123", "GH-1", "abcdef1", "a".repeat(40), ":smile:"]) {
		it(`keeps GitHub references literal in headings, paragraphs, and lists: ${reference}`, async () => {
			const { writes } = await execute({ raw: report(`### ${reference}\n\n${reference}\n\n- ${reference}`) })
			const body = writes[0].body
			assert.ok(body.includes(`<h3><code>${reference}</code></h3>`))
			assert.ok(body.includes(`<p><code>${reference}</code></p>`))
			assert.ok(body.includes(`<li><code>${reference}</code></li>`))
		})
	}

	it("renders summary and survivor tables with literal escaped cell contents", async () => {
		const content = [
			"## Changed-code mutation testing",
			"",
			"| Package | Changed executable lines | Valid | Killed | Timeout | Survived | No coverage | Result |",
			"| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
			"| core | 1 | 1 | 0 | 0 | 1 | 0 | Advisory findings |",
			"",
			"#### `packages/core/src/value.ts`",
			"",
			"| Line | Status | Mutator | Replacement |",
			"| ---: | --- | --- | --- |",
			"| 4 | Survived | BooleanLiteral | a \\| b & </code><img src=x> @someone ![image](https://example.org) ``` |",
		].join("\n")
		const { writes } = await execute({ raw: report(content) })
		const body = writes[0].body
		assert.equal(body.match(/<table>/g).length, 2)
		assert.ok(body.includes("<th><code>Package</code></th>"))
		assert.ok(body.includes("<td><code>core</code></td>"))
		assert.ok(body.includes("<td><code>4</code></td>"))
		assert.ok(
			body.includes(
				"a | b &amp; &lt;/code&gt;&lt;img src=x&gt; @someone ![image](https://example.org) ```</code>",
			),
		)
		assert.ok(!body.includes("<img"))
	})

	for (const content of ["| Value |\n| invalid |\n| @someone |", "| One | Two |\n| --- |\n| @someone |"]) {
		it(`keeps malformed table syntax literal: ${content.split("\n")[0]}`, async () => {
			const { writes } = await execute({ raw: report(content) })
			assert.ok(writes[0].body.includes("<p>"))
			assert.ok(!writes[0].body.includes("<table>"))
		})
	}

	it("bounds a large paragraph without emitting incomplete HTML", async () => {
		const { writes } = await execute({ raw: report("@someone\n".repeat(10000)) })
		assert.ok(writes[0].body.length < 65536)
		assert.ok(writes[0].body.includes("[truncated -"))
		assert.ok(writes[0].body.endsWith("</details>\n"))
	})

	it("truncates large tables between rows and closes their HTML structure", async () => {
		const content = "| Line | Replacement |\n| ---: | --- |\n" + "| 1 | & <img> @someone |\n".repeat(10000)
		const { writes } = await execute({ raw: report(content) })
		const body = writes[0].body
		assert.ok(body.length < 65536)
		assert.ok(body.includes("</tbody></table>\n\n[truncated -"))
		assert.equal(body.match(/<tr>/g).length, body.match(/<\/tr>/g).length)
		assert.ok(!body.includes("<img>"))
	})
})

// Resolve uses the same trusted workflow source as the comment execution tests.
describe("mutation target resolution execution", () => {
	const head = "a".repeat(40)
	async function execute({
		pullRequests = [],
		candidates = [],
		event = "pull_request",
		artifacts = [{ id: 42, name: "changed-code-mutation-report", expired: false }],
	} = {}) {
		const workflow = parseYaml(
			fs.readFileSync(path.join(repositoryRoot, ".github/workflows/mutation-pr-comment.yml"), "utf8"),
		)
		const outputs = {}
		const queries = []
		await runInNewContext(`(async () => {${workflow.jobs.resolve.steps[0].with.script}\n})()`, {
			context: {
				repo: { owner: "Zoo-Code-Org", repo: "Zoo-Code" },
				payload: {
					workflow_run: {
						id: 99,
						event,
						pull_requests: pullRequests,
						head_sha: head,
						head_branch: "feature",
						head_repository: { owner: { login: "fork-owner" } },
					},
				},
			},
			core: {
				info: () => {},
				setOutput: (name, value) => {
					outputs[name] = value
				},
			},
			github: {
				request: async (route, query) => {
					assert.equal(route, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts")
					assert.equal(query.run_id, 99)
					return { data: { artifacts } }
				},
				rest: {
					pulls: { list: () => {} },
				},
				paginate: async (_method, query) => {
					queries.push(query)
					return candidates
				},
			},
		})
		return { outputs, queries }
	}

	it("uses event PR numbers without querying fork candidates", async () => {
		const { outputs, queries } = await execute({ pullRequests: [{ number: 2293 }, { number: 2293 }] })
		assert.equal(outputs.pr_numbers, "[2293]")
		assert.equal(outputs.artifact_id, "42")
		assert.equal(queries.length, 0)
	})

	for (const [name, sha, repository, expected] of [
		["matching fork", head, "Zoo-Code-Org/Zoo-Code", "[2293]"],
		["wrong head", "b".repeat(40), "Zoo-Code-Org/Zoo-Code", "[]"],
		["wrong base repository", head, "other/repo", "[]"],
	]) {
		it(`resolves ${name} with an exact owner, branch, SHA, and base match`, async () => {
			const { outputs, queries } = await execute({
				candidates: [{ number: 2293, head: { sha }, base: { repo: { full_name: repository } } }],
			})
			assert.equal(outputs.pr_numbers, expected)
			assert.equal(queries[0].head, "fork-owner:feature")
			assert.equal(queries[0].state, "open")
		})
	}

	for (const [name, artifacts] of [
		["missing", []],
		["expired", [{ id: 42, name: "changed-code-mutation-report", expired: true }]],
		["unrelated", [{ id: 42, name: "other-report", expired: false }]],
	]) {
		it(`skips comment publication for ${name} artifacts`, async () => {
			assert.equal((await execute({ artifacts })).outputs.artifact_id, "")
		})
	}

	it("ignores non-PR runs", async () => {
		const { outputs, queries } = await execute({ event: "merge_group" })
		assert.equal(outputs.pr_numbers, "[]")
		assert.equal(outputs.artifact_id, "")
		assert.equal(queries.length, 0)
	})
})
