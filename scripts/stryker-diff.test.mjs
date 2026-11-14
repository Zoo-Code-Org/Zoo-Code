import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"
import { parse as parseYaml } from "yaml"

import {
	DRY_RUN_TIMEOUT_MINUTES,
	ENGINE_DEFAULT_DRY_RUN_MINUTES,
	MAX_CHANGED_LINES,
	MAX_MUTANTS,
	PACKAGE_CONFIGS,
	PR_COMMENT_FILENAME,
	PR_COMMENT_MARKER,
	REJECTION_FILENAME,
	SPAWN_GRACE_MINUTES,
	spawnTimeoutMs,
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
	mutantCounts,
	parseChangedLines,
	parseNameStatus,
	parseVitestTestFiles,
	preferDirectTestFiles,
	recordRejection,
	resolveDeclaredBinEntry,
	resolveStrykerBinary,
	resolveStrykerTempDir,
	resolveVitestBinary,
	shouldUseVitestRelated,
	packageForPath,
	runManifest,
	selectFromGit,
	testsFromMutationReport,
	validateDisableDirectives,
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
		const previousWarn = console.warn
		const warnings = []
		const summaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-summary-"))
		// The platform hands this write a regular file, so the simulation targets a file path it cannot
		// create instead of a directory, which no platform value of GITHUB_STEP_SUMMARY has ever been.
		const summaryTarget = path.join(summaryDirectory, "absent", "_summary.md")
		process.env.GITHUB_STEP_SUMMARY = summaryTarget
		console.warn = (warning) => warnings.push(warning)

		try {
			assert.doesNotThrow(() => appendSummary([], ["advisory"], {}))
			// A file the platform promised and the gate could not create is the failure; the advisory names
			// the file it failed on instead of staying quiet about it.
			assert.deepEqual(warnings, [
				"::warning title=Mutation test advisory::advisory",
				"::warning title=Mutation test advisory::Could not write the job summary: ENOENT: no such file or directory, open '" +
					summaryTarget +
					"'",
			])
		} finally {
			if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY
			else process.env.GITHUB_STEP_SUMMARY = previousSummary
			console.warn = previousWarn
			fs.rmSync(summaryDirectory, { recursive: true, force: true })
		}
	})

	it("names the file it could not append the job summary to", () => {
		const previousSummary = process.env.GITHUB_STEP_SUMMARY
		const previousWarn = console.warn
		const warnings = []
		const summaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-summary-"))
		const summaryTarget = path.join(summaryDirectory, "absent", "_summary.md")
		process.env.GITHUB_STEP_SUMMARY = summaryTarget
		console.warn = (warning) => warnings.push(warning)

		try {
			appendSummary([], [], {})
			const summaryWarning = warnings.find((warning) =>
				warning.includes("::warning title=Mutation test advisory::Could not write the job summary"),
			)
			assert.ok(summaryWarning, warnings.join(" | "))
			assert.ok(summaryWarning.includes(summaryTarget), summaryWarning)
			assert.ok(summaryWarning.includes("ENOENT"), summaryWarning)
		} finally {
			if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY
			else process.env.GITHUB_STEP_SUMMARY = previousSummary
			console.warn = previousWarn
			fs.rmSync(summaryDirectory, { recursive: true, force: true })
		}
	})

	it("appends the summary to the file the platform provides", () => {
		const previousSummary = process.env.GITHUB_STEP_SUMMARY
		const previousWarn = console.warn
		const warnings = []
		const summaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-summary-"))
		const summaryFile = path.join(summaryDirectory, "_summary.md")
		fs.writeFileSync(summaryFile, "# written by an earlier step\n")
		process.env.GITHUB_STEP_SUMMARY = summaryFile
		console.warn = (warning) => warnings.push(warning)
		const manifest = { baseSha: "a".repeat(40), headSha: "b".repeat(40) }

		try {
			appendSummary([], ["manifest advisory"], manifest)
			const written = fs.readFileSync(summaryFile, "utf8")
			assert.ok(written.startsWith("# written by an earlier step\n"), written.slice(0, 120))
			assert.ok(written.includes(formatSummary([], ["manifest advisory"], manifest)), written.slice(0, 120))
			assert.deepEqual(warnings, ["::warning title=Mutation test advisory::manifest advisory"])
		} finally {
			if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY
			else process.env.GITHUB_STEP_SUMMARY = previousSummary
			console.warn = previousWarn
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

describe("gate rejection record", () => {
	const rejectionMessage =
		"extension has 2328 changed executable lines (limit 500). Split the PR or obtain a maintainer-reviewed narrow exclusion."
	const rejectionError = () => new Error(rejectionMessage)
	const headSha = "b".repeat(40)
	const baseSha = "c".repeat(40)

	it("records the rejection in the report root the artifact step uploads", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-rejection-"))
		const reportRoot = path.join(repo, "reports", "mutation")
		const previousSummary = process.env.GITHUB_STEP_SUMMARY
		delete process.env.GITHUB_STEP_SUMMARY

		try {
			assert.equal(fs.existsSync(reportRoot), false)
			assert.doesNotThrow(() => recordRejection(reportRoot, baseSha, headSha, rejectionError()))
			const body = fs.readFileSync(path.join(reportRoot, REJECTION_FILENAME), "utf8")
			assert.ok(body.includes("Mutation gate rejected: " + rejectionMessage), body.slice(0, 200))
			assert.ok(body.includes("- Base: `" + baseSha.slice(0, 12) + "`"), body.slice(0, 200))
			assert.ok(body.includes("- Head: `" + headSha.slice(0, 12) + "`"), body.slice(0, 200))
			assert.deepEqual(fs.readdirSync(reportRoot), [REJECTION_FILENAME])
		} finally {
			if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY
			else process.env.GITHUB_STEP_SUMMARY = previousSummary
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("appends the rejection to the job summary the platform provides", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-rejection-"))
		const reportRoot = path.join(repo, "reports", "mutation")
		const summaryFile = path.join(repo, "_summary.md")
		const previousSummary = process.env.GITHUB_STEP_SUMMARY
		const previousWarn = console.warn
		const warnings = []
		fs.writeFileSync(summaryFile, "")
		process.env.GITHUB_STEP_SUMMARY = summaryFile
		console.warn = (warning) => warnings.push(warning)

		try {
			recordRejection(reportRoot, baseSha, headSha, rejectionError())
			assert.deepEqual(warnings, [])
			const written = fs.readFileSync(summaryFile, "utf8")
			assert.ok(written.includes("Mutation gate rejected: " + rejectionMessage), written.slice(0, 200))
		} finally {
			if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY
			else process.env.GITHUB_STEP_SUMMARY = previousSummary
			console.warn = previousWarn
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("leaves an advisory instead of throwing when the report root cannot be written", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-rejection-"))
		const occupied = path.join(repo, "reports")
		const previousSummary = process.env.GITHUB_STEP_SUMMARY
		const previousWarn = console.warn
		const warnings = []
		fs.writeFileSync(occupied, "not a directory")
		delete process.env.GITHUB_STEP_SUMMARY
		console.warn = (warning) => warnings.push(warning)

		try {
			assert.doesNotThrow(() => recordRejection(occupied, baseSha, headSha, rejectionError()))
			assert.equal(warnings.length, 1, warnings.join(" | "))
			assert.ok(
				warnings[0].startsWith(
					"::warning title=Mutation test advisory::Could not write the mutation gate rejection file:",
				),
				warnings[0],
			)
			assert.ok(warnings[0].includes(occupied), warnings[0])
		} finally {
			if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY
			else process.env.GITHUB_STEP_SUMMARY = previousSummary
			console.warn = previousWarn
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("leaves its record in the report root when the gate rejects a delta", () => {
		// The script resolves its own imports from the repository it lives in, so the synthetic
		// repository is built inside this one, where git ignores it and node can resolve typescript.
		const scratchRoot = path.join(repositoryRoot, "reports", "mutation")
		fs.mkdirSync(scratchRoot, { recursive: true })
		const scratch = fs.mkdtempSync(path.join(scratchRoot, "u917-rejection-"))
		const run = (...args) => execFileSync("git", args, { cwd: scratch, encoding: "utf8" }).trim()
		const write = (filePath, contents) => {
			fs.mkdirSync(path.join(scratch, path.dirname(filePath)), { recursive: true })
			fs.writeFileSync(path.join(scratch, filePath), contents)
		}

		try {
			run("init", "--quiet", "--initial-branch", "main")
			run("config", "user.email", "gate@example.com")
			run("config", "user.name", "Gate")
			run("config", "commit.gpgsign", "false")
			run("config", "core.hooksPath", path.join(scratch, ".no-hooks"))
			write("packages/core/src/value.ts", "export const value = () => 1\n")
			run("add", ".")
			run("commit", "--quiet", "-m", "initial")
			const beforeSha = run("rev-parse", "HEAD")

			const lines = Array.from(
				{ length: MAX_CHANGED_LINES + 50 },
				(_, index) => "export const value" + index + " = " + index,
			)
			write("packages/core/src/value.ts", lines.join("\n") + "\n")
			run("add", ".")
			run("commit", "--quiet", "-m", "delta above the changed-line limit")
			const afterSha = run("rev-parse", "HEAD")

			fs.mkdirSync(path.join(scratch, "scripts"), { recursive: true })
			fs.copyFileSync(
				path.join(repositoryRoot, "scripts/stryker-diff.mjs"),
				path.join(scratch, "scripts/stryker-diff.mjs"),
			)
			const result = spawnSync(
				process.execPath,
				["scripts/stryker-diff.mjs", "ci", "--base", beforeSha, "--head", afterSha, "--reports", "rejection"],
				{ cwd: scratch, encoding: "utf8", timeout: 120000 },
			)

			assert.equal(result.status, 1, String(result.stderr).slice(0, 300))
			assert.ok(
				String(result.stderr).includes("changed executable lines (limit " + MAX_CHANGED_LINES + ")"),
				String(result.stderr).slice(0, 300),
			)
			const reportDirectory = path.join(scratch, "rejection")
			const recorded = fs.readFileSync(path.join(reportDirectory, REJECTION_FILENAME), "utf8")
			assert.ok(recorded.includes("Mutation gate rejected: core has "), recorded.slice(0, 240))
			assert.deepEqual(fs.readdirSync(reportDirectory), [REJECTION_FILENAME])
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true })
		}
	})
})

describe("declared binary resolution", () => {
	const writeDeclaredPackage = (repo, packageName, bin, contents = "") => {
		const packageDir = path.join(repo, "node_modules", packageName)
		fs.mkdirSync(packageDir, { recursive: true })
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: packageName, bin }))
		const entry = typeof bin === "string" ? bin : Object.values(bin)[0]
		const entryPath = path.join(packageDir, entry.replace(/^\.\//, ""))
		fs.mkdirSync(path.dirname(entryPath), { recursive: true })
		fs.writeFileSync(entryPath, contents)
		return entryPath
	}

	it("reads the executable entry the package declares in both npm forms", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-declared-"))

		try {
			const mapped = writeDeclaredPackage(repo, "vitest", { vitest: "./vitest.mjs" })
			assert.equal(resolveDeclaredBinEntry(repo, repo, "vitest", "vitest", repo), mapped)
			const single = writeDeclaredPackage(repo, "@stryker-mutator/core", "./bin/stryker.js")
			assert.equal(resolveDeclaredBinEntry(repo, repo, "@stryker-mutator/core", "stryker", repo), single)
		} finally {
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("gives up when the declared file or the declaration is missing", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-declared-"))
		const packageDir = path.join(repo, "node_modules", "vitest")
		const packageJson = path.join(packageDir, "package.json")

		try {
			const entry = writeDeclaredPackage(repo, "vitest", { vitest: "./vitest.mjs" })
			fs.rmSync(entry)
			assert.equal(resolveDeclaredBinEntry(repo, repo, "vitest", "vitest", repo), undefined)
			fs.writeFileSync(packageJson, JSON.stringify({ name: "vitest" }))
			assert.equal(resolveDeclaredBinEntry(repo, repo, "vitest", "vitest", repo), undefined)
			fs.writeFileSync(packageJson, "{ not json")
			assert.equal(resolveDeclaredBinEntry(repo, repo, "vitest", "vitest", repo), undefined)
		} finally {
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("prefers the declared entry over the platform shim", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-declared-"))
		const strykerShim = path.join(repo, "node_modules", ".bin", "stryker")
		fs.mkdirSync(path.dirname(strykerShim), { recursive: true })
		fs.writeFileSync(strykerShim, "")
		const strykerEntry = writeDeclaredPackage(repo, "@stryker-mutator/core", { stryker: "./bin/stryker.js" })
		const vitestEntry = writeDeclaredPackage(repo, "vitest", { vitest: "./vitest.mjs" })
		const packageShim = path.join(repo, "packages", "core", "node_modules", ".bin", "vitest")
		fs.mkdirSync(path.dirname(packageShim), { recursive: true })
		fs.writeFileSync(packageShim, "")
		const packageEntry = {
			id: "core",
			root: "packages/core",
			vitestConfig: "vitest.unit.config.ts",
		}

		try {
			assert.equal(resolveStrykerBinary(repo, repo), strykerEntry)
			assert.equal(resolveVitestBinary(repo, packageEntry), vitestEntry)
		} finally {
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("falls back to the repository shim when nothing is declared", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-declared-"))
		const strykerShim = path.join(repo, "node_modules", ".bin", "stryker")
		fs.mkdirSync(path.dirname(strykerShim), { recursive: true })
		fs.writeFileSync(strykerShim, "")

		try {
			assert.equal(resolveStrykerBinary(repo, repo), strykerShim)
			assert.equal(
				resolveVitestBinary(repo, { id: "core", root: "packages/core", vitestConfig: "vitest.unit.config.ts" }),
				path.join(repo, "node_modules", ".bin", "vitest"),
			)
		} finally {
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("runs a JavaScript entry with the Node binary that is running the gate", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-vitest-entry-"))
		const reportDirectory = path.join(repo, "reports")
		const previousTestFile = process.env.U917_VITEST_TEST_FILE
		const fake = [
			'import fs from "node:fs"',
			"const args = process.argv.slice(2)",
			'const outputFile = args.find((arg) => arg.startsWith("--outputFile=")).slice("--outputFile=".length)',
			'fs.writeFileSync(outputFile + ".exec.json", JSON.stringify({ execPath: process.execPath, argv: process.argv.slice(1) }))',
			"fs.writeFileSync(outputFile, JSON.stringify({ testResults: [{ name: process.env.U917_VITEST_TEST_FILE }] }))",
		].join("\n")
		const entry = writeDeclaredPackage(repo, "vitest", { vitest: "./vitest.mjs" }, fake)
		fs.mkdirSync(path.join(repo, "src", "utils"), { recursive: true })
		fs.mkdirSync(reportDirectory, { recursive: true })
		const packageEntry = {
			id: "extension",
			root: "src",
			vitestConfig: "vitest.config.ts",
			selectors: ["utils/value.ts:1-1"],
		}
		process.env.U917_VITEST_TEST_FILE = path.join(repo, "src", "utils", "value.test.ts")

		try {
			assert.deepEqual(discoverRelatedTestFiles(repo, packageEntry, reportDirectory), ["utils/value.test.ts"])
			const record = JSON.parse(
				fs.readFileSync(path.join(reportDirectory, "vitest-related.json.exec.json"), "utf8"),
			)
			assert.equal(record.execPath, process.execPath)
			assert.equal(record.argv[0], entry)
			assert.equal(record.argv[1], "related")
			assert.ok(
				record.argv.some((arg) => arg.startsWith("--outputFile=")),
				record.argv.join(" "),
			)
		} finally {
			if (previousTestFile === undefined) delete process.env.U917_VITEST_TEST_FILE
			else process.env.U917_VITEST_TEST_FILE = previousTestFile
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})
})

describe("initial-test-run budget", () => {
	const packageEntry = {
		id: "core",
		root: "packages/core",
		vitestConfig: "vitest.unit.config.ts",
		selectors: ["src/value.ts:1-1"],
		changedExecutableLines: 1,
	}
	const writeStrykerStub = (repo, exitCode) => {
		const packageDir = path.join(repo, "node_modules", "@stryker-mutator", "core")
		fs.mkdirSync(packageDir, { recursive: true })
		fs.writeFileSync(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name: "@stryker-mutator/core", bin: { stryker: "./bin/stryker.js" } }),
		)
		const entryPath = path.join(packageDir, "bin", "stryker.js")
		fs.mkdirSync(path.dirname(entryPath), { recursive: true })
		const stub = [
			'const fs = require("node:fs")',
			"const args = process.argv.slice(2)",
			'const kind = args.includes("--dryRunOnly") ? "preflight" : "run"',
			'fs.writeFileSync(process.env.U917_STRYKER_RECORD + "." + kind + ".json", JSON.stringify({ execPath: process.execPath, argv1: process.argv[1], args }))',
			'if (kind === "preflight") console.log("Instrumented 1 source file(s) with 1 mutant(s)")',
			"process.exit(" + exitCode + ")",
		].join("\n")
		fs.writeFileSync(entryPath, stub)
		return entryPath
	}
	const readInvocation = (recordPath, kind) => JSON.parse(fs.readFileSync(recordPath + "." + kind + ".json", "utf8"))

	it("keeps the outer kill above the budget handed to the engine", () => {
		assert.equal(DRY_RUN_TIMEOUT_MINUTES, 20)
		assert.equal(ENGINE_DEFAULT_DRY_RUN_MINUTES, 5)
		assert.equal(SPAWN_GRACE_MINUTES, 5)
		assert.equal(spawnTimeoutMs, (DRY_RUN_TIMEOUT_MINUTES + SPAWN_GRACE_MINUTES) * 60 * 1000)
		assert.ok(spawnTimeoutMs > DRY_RUN_TIMEOUT_MINUTES * 60 * 1000)
	})

	it("hands every Stryker invocation the budget it names and logs the binary it used", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-budget-"))
		const reportRoot = path.join(repo, "reports")
		const recordPath = path.join(repo, "argv.json")
		const previousRecord = process.env.U917_STRYKER_RECORD
		const previousLog = console.log
		const previousWarn = console.warn
		const logs = []
		process.env.U917_STRYKER_RECORD = recordPath
		fs.mkdirSync(path.join(repo, "packages", "core", "src"), { recursive: true })
		const entry = writeStrykerStub(repo, 0)
		console.log = (line) => logs.push(String(line))
		console.warn = () => {}

		try {
			const rows = runManifest(repo, { packages: [{ ...packageEntry }] }, reportRoot, {
				readMutationReport: () => ({ files: {} }),
			})
			assert.equal(rows.length, 1)
			const preflight = readInvocation(recordPath, "preflight")
			const run = readInvocation(recordPath, "run")
			for (const invocation of [preflight, run]) {
				const budgetAt = invocation.args.indexOf("--dryRunTimeoutMinutes")
				assert.ok(budgetAt >= 0, invocation.args.join(" "))
				assert.equal(invocation.args[budgetAt + 1], String(DRY_RUN_TIMEOUT_MINUTES))
				assert.equal(invocation.execPath, process.execPath)
				assert.equal(invocation.argv1, entry)
			}
			assert.equal(preflight.args.includes("--dryRunOnly"), true)
			assert.equal(run.args.includes("--dryRunOnly"), false)
			const reported = logs.join("\n")
			assert.ok(
				logs.some(
					(line) =>
						line.includes("Stryker preflight starting via") && line.includes(path.relative(repo, entry)),
				),
				reported.slice(0, 400),
			)
			assert.ok(
				logs.some((line) =>
					line.includes(
						"initial-test-run budget " +
							DRY_RUN_TIMEOUT_MINUTES +
							" min (engine schema default " +
							ENGINE_DEFAULT_DRY_RUN_MINUTES +
							" min)",
					),
				),
				reported.slice(0, 400),
			)
		} finally {
			if (previousRecord === undefined) delete process.env.U917_STRYKER_RECORD
			else process.env.U917_STRYKER_RECORD = previousRecord
			console.log = previousLog
			console.warn = previousWarn
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})

	it("names the budget, the binary, and that the exit is not a verdict when the engine fails", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-budget-"))
		const reportRoot = path.join(repo, "reports")
		const recordPath = path.join(repo, "argv.json")
		const previousRecord = process.env.U917_STRYKER_RECORD
		const previousLog = console.log
		const previousWarn = console.warn
		const warnings = []
		process.env.U917_STRYKER_RECORD = recordPath
		fs.mkdirSync(path.join(repo, "packages", "core", "src"), { recursive: true })
		const entry = writeStrykerStub(repo, 1)
		console.log = () => {}
		console.warn = (warning) => warnings.push(String(warning))

		try {
			const rows = runManifest(repo, { packages: [{ ...packageEntry }] }, reportRoot, {
				readMutationReport: () => ({ files: {} }),
			})
			assert.equal(rows[0].result, "Advisory incomplete")
			const failure = warnings.find((warning) => warning.includes("Stryker preflight failed via"))
			assert.ok(failure, warnings.join(" | ").slice(0, 400))
			assert.ok(
				failure.includes(
					"initial-test-run budget " +
						DRY_RUN_TIMEOUT_MINUTES +
						" min (engine schema default " +
						ENGINE_DEFAULT_DRY_RUN_MINUTES +
						" min)",
				),
				failure.slice(0, 400),
			)
			assert.ok(failure.includes("(exit 1, which is not a mutant verdict on its own)"), failure.slice(0, 400))
			assert.ok(failure.includes(path.relative(repo, entry)), failure.slice(0, 400))
			assert.equal(fs.existsSync(recordPath + ".run.json"), false)
		} finally {
			if (previousRecord === undefined) delete process.env.U917_STRYKER_RECORD
			else process.env.U917_STRYKER_RECORD = previousRecord
			console.log = previousLog
			console.warn = previousWarn
			fs.rmSync(repo, { recursive: true, force: true })
		}
	})
})
