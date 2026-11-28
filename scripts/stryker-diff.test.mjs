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
	mutantCounts,
	parseChangedLines,
	parseNameStatus,
	parseVitestTestFiles,
	preferDirectTestFiles,
	parseStackedMap,
	readStackedMap,
	reinstallFailureDetail,
	summarizeReinstallFailure,
	dependencyManifestDrift,
	alignExecutionTree,
	resolveCiInvocation,
	resolveStackedUnitBase,
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
		assert.ok(workflow.includes("pull-requests: read"))
		// The event value is the authoritative provenance for the PR comment, so the run block keeps it
		// when present and derives it from the merge commit only as a fallback for a manual run with no
		// pull_request payload. Both spellings must stay: the derivation is what identifies the stacked
		// unit when nothing supplies the head.
		assert.ok(
			workflow.includes(
				'PR_HEAD_SHA="${PR_HEAD_SHA:-$(git rev-parse "$HEAD_SHA^2" 2>/dev/null || git rev-parse "$HEAD_SHA")}"',
			),
		)
		// The map crosses jobs as a file, never as an argument or an environment string: Linux caps one
		// argument/env string at 128 KiB (MAX_ARG_STRLEN), and a map past that cap makes the step
		// unstartable rather than merely large.
		assert.ok(workflow.includes('--stacked-map-file "${RUNNER_TEMP}/mutation-stacked-map/stacked-map.json"'))
		// The map must land outside the checkout: a pull request can commit .mutation/stacked-map.json,
		// and with continue-on-error a missing artifact would leave that committed file in front of the
		// gate, which then measures against whatever base the pull request chose for itself.
		assert.ok(workflow.includes("path: ${{ runner.temp }}/mutation-stacked-map"))
		assert.ok(!workflow.includes("path: .mutation"))
		assert.ok(!workflow.includes('--stacked-map "$STACKED_MAP"'))
		assert.ok(workflow.includes("name: mutation-stacked-map"))
		assert.ok(workflow.includes('--pr-head "$PR_HEAD_SHA"'))
		// The open pull request map must cover every page, otherwise a parent unit beyond the first
		// page is missing and the gate charges the whole unmerged chain again.
		// gh api rejects --slurp together with --jq, so pagination has to keep the per-page filter
		// and the parser has to accept the resulting stream of page arrays.
		assert.ok(workflow.includes("gh api --paginate"))
		assert.ok(!workflow.includes("--slurp"))
		// The map has to carry the draft flag: the gate refuses a draft head as a stacked base,
		// because a draft pull request is not gated (see the draft-base case below).
		assert.ok(
			workflow.includes(
				"[.[] | {number: .number, headSha: .head.sha, draft: (.draft == true), baseRef: .base.ref}]",
			),
		)
		// The gate has to know which branch this pull request targets, otherwise it cannot tell whether
		// the parent it measures against lands on the same branch.
		assert.ok(workflow.includes("PR_BASE_REF: ${{ github.event.pull_request.base.ref }}"))
		assert.ok(workflow.includes('--pr-base-ref "$PR_BASE_REF"'))
		// The fallback has to be a command: these steps run bash with -e, so a bare '[]' is executed
		// as a program name instead of producing JSON.
		assert.ok(workflow.includes("printf '[]'"))
		assert.ok(!workflow.includes("github.event.pull_request.base.sha"))
		assert.ok(workflow.includes("steps.mutation_report.outputs.artifact-url"))
		assert.ok(workflow.includes("open the package's mutation.html file"))
		assert.ok(workflow.includes("Enforce executable-line scope and run advisory mutation testing"))
		// The gate hands its environment to the Vitest discovery subprocesses, so the token has to stay
		// in a job that never checks out or runs pull-request code; only the filtered map crosses over.
		const gateJob = workflow.slice(workflow.indexOf("    mutation-diff:"))
		assert.ok(!gateJob.includes("GH_TOKEN"))
		// The map arrives from the artifact the map job publishes, into the job that runs the gate.
		assert.ok(gateJob.includes("uses: actions/download-artifact@"))
		assert.ok(gateJob.includes("name: mutation-stacked-map"))
		assert.ok(!workflow.includes("needs.stacked_map.outputs.stacked_map"))
		const mapJob = workflow.slice(workflow.indexOf("    stacked_map:"), workflow.indexOf("    mutation-diff:"))
		assert.ok(mapJob.includes("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}"))
		assert.ok(!mapJob.includes("actions/checkout"))
		assert.ok(!mapJob.includes("setup-node-pnpm"))
		assert.ok(!mapJob.includes("pnpm test:mutation-ci"))
		assert.ok(workflow.includes("needs: stacked_map"))
		// The map is validated before it is written, and the write is a plain file in the job that
		// uploads it: no step output, no job output, and no argument for the gate to receive.
		assert.ok(mapJob.includes(`printf '%s\\n' "$STACKED_MAP" > stacked-map.json`))
		assert.ok(mapJob.includes("path: stacked-map.json"))
		assert.ok(mapJob.includes("if-no-files-found: error"))
		assert.ok(!mapJob.includes("GITHUB_OUTPUT"))
		// Both jobs need actions:write - one to publish the map, one to read it and publish the reports.
		assert.equal(workflow.match(/actions: write/g)?.length, 2)
		// A missing map artifact degrades to the event base inside the script, so the download step must
		// not fail the job. The upload that produces it is tolerant for the same reason: a failed upload
		// would otherwise fail this job and skip the gate entirely, so the fallback could never run. The
		// report upload keeps its own tolerance.
		assert.equal(workflow.match(/continue-on-error: true/g)?.length, 3)
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

describe("stacked unit base resolution", () => {
	const createSyntheticStack = () => {
		const repository = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-stack-"))
		// Setup can fail halfway (a missing git config, a failed commit), and the callers only get the
		// repository path back on success, so cleanup has to happen here or the temp directory leaks.
		try {
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
			run("add", ".")
			run("commit", "--quiet", "-m", "initial")
			const eventBaseSha = run("rev-parse", "HEAD")

			run("checkout", "--quiet", "-b", "unit-1")
			write("packages/core/src/unit1.ts", "export const unit1 = () => 1\n")
			run("add", ".")
			run("commit", "--quiet", "-m", "unit 1")
			const parentSha = run("rev-parse", "HEAD")

			// The stacked unit is one commit on top of the parent unit's head.
			write("packages/core/src/unit2.ts", "export const unit2 = () => 2\n")
			run("add", ".")
			run("commit", "--quiet", "-m", "unit 2")
			const childSha = run("rev-parse", "HEAD")

			return { repository, eventBaseSha, parentSha, childSha, run, write }
		} catch (error) {
			fs.rmSync(repository, { recursive: true, force: true })
			throw error
		}
	}

	it("measures a stacked unit against the parent pull request head", () => {
		const { repository, eventBaseSha, parentSha, childSha } = createSyntheticStack()

		try {
			const resolved = resolveStackedUnitBase(
				repository,
				eventBaseSha,
				childSha,
				[{ number: 1, headSha: parentSha, draft: false, baseRef: "main" }],
				"main",
			)
			assert.equal(resolved.baseSha, parentSha)
			assert.equal(resolved.stackedOn, 1)

			const manifest = selectFromGit(repository, resolved.baseSha, childSha)
			assert.deepEqual(
				manifest.packages.flatMap((entry) => entry.files.map((file) => file.path)),
				["packages/core/src/unit2.ts"],
			)
		} finally {
			fs.rmSync(repository, { recursive: true, force: true })
		}
	})

	it("preserves the resolved stacked base when selection runs on the merge commit", () => {
		const { repository, eventBaseSha, parentSha, childSha, run, write } = createSyntheticStack()

		try {
			// GitHub runs the gate on its own merge commit: first parent is the base tip, second
			// parent is the pull request head.
			run("checkout", "--quiet", "-b", "merge-branch", eventBaseSha)
			write("packages/core/src/unrelated.ts", "export const unrelated = () => 2\n")
			run("add", ".")
			run("commit", "--quiet", "-m", "base advance")
			const advancedBase = run("rev-parse", "HEAD")
			run("merge", "--no-ff", "--quiet", "-m", "merge", childSha)
			const mergeSha = run("rev-parse", "HEAD")

			const resolved = resolveStackedUnitBase(
				repository,
				advancedBase,
				childSha,
				[{ number: 1, headSha: parentSha, draft: false, baseRef: "main" }],
				"main",
			)
			assert.equal(resolved.baseSha, parentSha)
			assert.equal(resolved.stackedOn, 1)

			// Without preserving the resolved base, selection re-derives it from the merge commit and
			// charges the whole unmerged chain to this unit.
			const charged = selectFromGit(repository, resolved.baseSha, mergeSha)
			assert.deepEqual(
				charged.packages.flatMap((entry) => entry.files.map((file) => file.path)),
				["packages/core/src/unit1.ts", "packages/core/src/unit2.ts"],
			)

			// With the base preserved, the unit is measured against its own head: the merge commit also
			// carries the base advance, which is not this unit's delta.
			const unit = selectFromGit(repository, resolved.baseSha, childSha, { preserveBase: true })
			assert.deepEqual(
				unit.packages.flatMap((entry) => entry.files.map((file) => file.path)),
				["packages/core/src/unit2.ts"],
			)

			// A non-stacked pull request still measures against the merge commit, so the base actually
			// merged into is used and the base advance is not charged to the pull request.
			const plain = selectFromGit(repository, advancedBase, mergeSha, { preserveBase: true })
			assert.deepEqual(
				plain.packages.flatMap((entry) => entry.files.map((file) => file.path)),
				["packages/core/src/unit1.ts", "packages/core/src/unit2.ts"],
			)
		} finally {
			fs.rmSync(repository, { recursive: true, force: true })
		}
	})

	it("keeps the event base when the parent commit is not another pull request head", () => {
		const { repository, eventBaseSha, parentSha, childSha } = createSyntheticStack()

		try {
			const resolved = resolveStackedUnitBase(repository, eventBaseSha, childSha, [], "main")
			assert.equal(resolved.baseSha, eventBaseSha)
			assert.equal(resolved.stackedOn, null)

			// A multi-commit pull request must not be charged only its last commit.
			const manifest = selectFromGit(repository, resolved.baseSha, childSha)
			assert.deepEqual(manifest.packages.flatMap((entry) => entry.files.map((file) => file.path)).sort(), [
				"packages/core/src/unit1.ts",
				"packages/core/src/unit2.ts",
			])
			void parentSha
		} finally {
			fs.rmSync(repository, { recursive: true, force: true })
		}
	})

	it("keeps the event base when the parent head belongs to a draft pull request", () => {
		// A draft pull request is not gated, so it cannot be the base a unit is measured against: the
		// unit would be charged only its own delta while the draft's content lands through it. The
		// unit keeps the event base instead, so that content is charged where it would land.
		const { repository, eventBaseSha, parentSha, childSha } = createSyntheticStack()

		try {
			const draft = resolveStackedUnitBase(
				repository,
				eventBaseSha,
				childSha,
				[{ number: 1, headSha: parentSha, draft: true, baseRef: "main" }],
				"main",
			)
			assert.equal(draft.baseSha, eventBaseSha)
			assert.equal(draft.stackedOn, null)

			// An entry whose draft flag is missing proves nothing about gating, so it keeps the event
			// base like a known draft does.
			const unconfirmed = resolveStackedUnitBase(
				repository,
				eventBaseSha,
				childSha,
				[{ number: 1, headSha: parentSha, baseRef: "main", draft: undefined }],
				"main",
			)
			assert.equal(unconfirmed.baseSha, eventBaseSha)
			assert.equal(unconfirmed.stackedOn, null)

			// The same entry, ready for review: the parent was gated, so it is the unit's base again.
			const ready = resolveStackedUnitBase(
				repository,
				eventBaseSha,
				childSha,
				[{ number: 1, headSha: parentSha, draft: false, baseRef: "main" }],
				"main",
			)
			assert.equal(ready.baseSha, parentSha)
			assert.equal(ready.stackedOn, 1)

			// The cumulative delta the cap has to see when the parent never gets gated.
			const manifest = selectFromGit(repository, draft.baseSha, childSha, { preserveBase: true })
			assert.deepEqual(manifest.packages.flatMap((entry) => entry.files.map((file) => file.path)).sort(), [
				"packages/core/src/unit1.ts",
				"packages/core/src/unit2.ts",
			])
		} finally {
			fs.rmSync(repository, { recursive: true, force: true })
		}
	})

	it("refuses a stacked parent that targets a different branch than this unit", () => {
		// A parent whose base is a feature branch was measured against that branch by its own gate.
		// Measuring this unit against its head would hide the parent's feature-branch delta from the
		// changed-line cap while merging this unit lands that delta on main, so the unit keeps the
		// event base and the cap sees the whole chain.
		const { repository, eventBaseSha, parentSha, childSha } = createSyntheticStack()

		try {
			const featureBranchParent = resolveStackedUnitBase(
				repository,
				eventBaseSha,
				childSha,
				[{ number: 1, headSha: parentSha, draft: false, baseRef: "feature/other" }],
				"main",
			)
			assert.equal(featureBranchParent.baseSha, eventBaseSha)
			assert.equal(featureBranchParent.stackedOn, null)

			// The same parent head, targeting the branch this unit targets, is the unit's real base.
			const sameBase = resolveStackedUnitBase(
				repository,
				eventBaseSha,
				childSha,
				[{ number: 1, headSha: parentSha, draft: false, baseRef: "main" }],
				"main",
			)
			assert.equal(sameBase.baseSha, parentSha)
			assert.equal(sameBase.stackedOn, 1)

			// Nothing can be compared when either side is unknown, so both keep the event base.
			const unknownUnitBase = resolveStackedUnitBase(
				repository,
				eventBaseSha,
				childSha,
				[{ number: 1, headSha: parentSha, draft: false, baseRef: "main" }],
				undefined,
			)
			assert.equal(unknownUnitBase.stackedOn, null)
			const unknownParentBase = resolveStackedUnitBase(
				repository,
				eventBaseSha,
				childSha,
				[{ number: 1, headSha: parentSha, draft: false }],
				"main",
			)
			assert.equal(unknownParentBase.stackedOn, null)

			// The cumulative delta the cap has to see when the parent cannot serve as the base.
			const manifest = selectFromGit(repository, featureBranchParent.baseSha, childSha, { preserveBase: true })
			assert.deepEqual(manifest.packages.flatMap((entry) => entry.files.map((file) => file.path)).sort(), [
				"packages/core/src/unit1.ts",
				"packages/core/src/unit2.ts",
			])
		} finally {
			fs.rmSync(repository, { recursive: true, force: true })
		}
	})

	it("matches a stacked parent by base branch when another pull request shares its head", () => {
		// Two open pull requests can point at the same commit while targeting different branches. Stopping
		// at the first head-SHA match rejects that parent for the wrong reason and falls back to the event
		// base, charging this unit every unmerged ancestor of a branch it is not merging into.
		const { repository, eventBaseSha, parentSha, childSha } = createSyntheticStack()

		try {
			const map = [
				{ number: 9, headSha: parentSha, draft: false, baseRef: "feature/other" },
				{ number: 1, headSha: parentSha, draft: false, baseRef: "main" },
			]

			const unitOnMain = resolveStackedUnitBase(repository, eventBaseSha, childSha, map, "main")
			assert.equal(unitOnMain.baseSha, parentSha)
			assert.equal(unitOnMain.stackedOn, 1)

			// The same map read by a unit that targets the feature branch picks the other pull request,
			// which is the only parent whose own gate measured against this unit's base.
			const unitOnFeature = resolveStackedUnitBase(repository, eventBaseSha, childSha, map, "feature/other")
			assert.equal(unitOnFeature.baseSha, parentSha)
			assert.equal(unitOnFeature.stackedOn, 9)

			// A map whose entries match no base still degrades instead of guessing.
			const noMatch = resolveStackedUnitBase(repository, eventBaseSha, childSha, map, "release/none")
			assert.equal(noMatch.baseSha, eventBaseSha)
			assert.equal(noMatch.stackedOn, null)
		} finally {
			fs.rmSync(repository, { recursive: true, force: true })
		}
	})

	it("reads the stacked map from the artifact file the workflow publishes", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stacked-map-"))
		try {
			fs.writeFileSync(
				path.join(directory, "stacked-map.json"),
				'[{ "number": 1, "headSha": "' + "a".repeat(40) + '", "draft": false, "baseRef": "main" }]',
			)
			const fromFile = parseStackedMap(readStackedMap(directory, "[]", "stacked-map.json"))
			assert.deepEqual(fromFile, [{ number: 1, headSha: "a".repeat(40), draft: false, baseRef: "main" }])

			// The inline form stays available for local runs, where no artifact exists.
			const inline = parseStackedMap(
				readStackedMap(
					directory,
					'[{ "number": 2, "headSha": "' + "b".repeat(40) + '", "draft": false, "baseRef": "main" }]',
					undefined,
				),
			)
			assert.deepEqual(inline, [{ number: 2, headSha: "b".repeat(40), draft: false, baseRef: "main" }])

			// A missing artifact must not stop the gate. Falling back to the event base charges this unit
			// every unmerged ancestor - stricter than the intended measurement, never looser - and the
			// warning records which case ran.
			const warnings = []
			const warn = console.warn
			console.warn = (message) => warnings.push(message)
			try {
				assert.equal(readStackedMap(directory, '[{ "number": 3 }]', "absent.json"), "")
			} finally {
				console.warn = warn
			}
			assert.equal(warnings.length, 1)
			assert.ok(warnings[0].includes("the artifact was not published"))
			assert.deepEqual(parseStackedMap(""), [])
		} finally {
			fs.rmSync(directory, { recursive: true, force: true })
		}
	})

	it("reports the stacked base in the job summary when the aligned reinstall fails", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reinstall-summary-"))
		const summaryPath = path.join(directory, "step-summary.md")
		const previous = process.env.GITHUB_STEP_SUMMARY
		process.env.GITHUB_STEP_SUMMARY = summaryPath
		const warnings = []
		const warn = console.warn
		console.warn = (message) => warnings.push(message)
		try {
			summarizeReinstallFailure(
				{ stackedOn: 7, baseSha: "1".repeat(40), diffHead: "2".repeat(40) },
				["src/package.json", "pnpm-lock.yaml"],
				new Error("pnpm install exited 1"),
			)
			const summary = fs.readFileSync(summaryPath, "utf8")
			// The whole point of the summary here: which base this unit was measured against, and the
			// command that reproduces it - the parent head moves, the selected base is what is left.
			assert.ok(summary.includes("Stacked unit: measured against the head of parent PR #7"))
			assert.ok(
				summary.includes(`node scripts/stryker-diff.mjs ci --base ${"1".repeat(40)} --head ${"2".repeat(40)}`),
			)
			assert.ok(summary.includes("git checkout " + "2".repeat(40)))
			assert.ok(summary.includes("src/package.json, pnpm-lock.yaml"))
			assert.ok(summary.includes("pnpm install exited 1"))
			assert.equal(warnings.length, 1)
		} finally {
			console.warn = warn
			if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY
			else process.env.GITHUB_STEP_SUMMARY = previous
			fs.rmSync(directory, { recursive: true, force: true })
		}
	})

	it("keeps the exit status when the reinstall writes nothing to stderr", () => {
		// A killed or signal-terminated pnpm leaves stderr empty, and "" is a valid ?? operand: with ?? the
		// report would end in a blank detail and lose the only fact that is left.
		assert.equal(reinstallFailureDetail({ status: 1, stderr: "" }), "exit 1")
		assert.equal(reinstallFailureDetail({ status: null, stderr: undefined }), "exit null")
		assert.equal(
			reinstallFailureDetail({ status: 1, stderr: "  ERR_PNPM_OUTDATED_LOCKFILE  " }),
			"ERR_PNPM_OUTDATED_LOCKFILE",
		)
		assert.equal(
			reinstallFailureDetail({ status: null, stderr: "", error: new Error("spawnSync pnpm ENOENT") }),
			"spawnSync pnpm ENOENT",
		)
	})

	it("degrades to the event base for an unparsable stacked map", () => {
		assert.deepEqual(parseStackedMap("not json"), [])
		assert.deepEqual(parseStackedMap('{"number": 1}'), [])
		assert.deepEqual(parseStackedMap('[{"number": 1, "headSha": "abc"}]'), [])
		assert.deepEqual(parseStackedMap('[{"number": 1, "headSha": "' + "a".repeat(40) + '"}]'), [
			{ number: 1, headSha: "a".repeat(40) },
		])

		// The base ref must survive the parse: rejecting a parent that targets a different branch is
		// only possible when the entry carries the ref it was filtered with.
		assert.deepEqual(
			parseStackedMap('[{"number": 1, "headSha": "' + "e".repeat(40) + '", "draft": false, "baseRef": "main"}]'),
			[{ number: 1, headSha: "e".repeat(40), draft: false, baseRef: "main" }],
		)

		// gh api --paginate emits one array per page, so a parent unit on page 2 arrives as a second
		// document rather than inside the first array.
		assert.deepEqual(
			parseStackedMap(
				'[{"number": 1, "headSha": "' +
					"b".repeat(40) +
					'"}]' +
					'[{"number": 2, "headSha": "' +
					"c".repeat(40) +
					'"}]',
			),
			[
				{ number: 1, headSha: "b".repeat(40) },
				{ number: 2, headSha: "c".repeat(40) },
			],
		)
		// Trailing content cannot be consumed as a page, so the whole map is rejected rather than
		// keeping a partial entry that could select a parent base.
		assert.deepEqual(parseStackedMap('[{"number": 1, "headSha": "' + "d".repeat(40) + '"}]garbage'), [])
		assert.deepEqual(parseStackedMap('[{"number": 1, "headSha": "' + "d".repeat(40) + '"}] [{"number": 2'), [])
	})

	it("the ci command picks the diff head from the commit graph", () => {
		const { repository, eventBaseSha, parentSha, childSha, run, write } = createSyntheticStack()

		try {
			run("checkout", "--quiet", "-b", "merge-branch", eventBaseSha)
			write("packages/core/src/unrelated.ts", "export const unrelated = () => 2\n")
			run("add", ".")
			run("commit", "--quiet", "-m", "base advance")
			const advancedBase = run("rev-parse", "HEAD")
			run("merge", "--no-ff", "--quiet", "-m", "merge", childSha)
			const mergeSha = run("rev-parse", "HEAD")

			// Stacked: base is the parent PR head and the diff head is the PR head, not the merge
			// commit, so the base advance is not charged to this unit.
			const stacked = resolveCiInvocation(
				repository,
				advancedBase,
				mergeSha,
				childSha,
				[{ number: 1, headSha: parentSha, draft: false, baseRef: "main" }],
				"main",
			)
			assert.equal(stacked.baseSha, parentSha)
			assert.equal(stacked.diffHead, childSha)
			assert.equal(stacked.stackedOn, 1)

			// Non-stacked: the merge commit stays the diff head and the base stays the event base.
			const plain = resolveCiInvocation(repository, advancedBase, mergeSha, childSha, [], "main")
			assert.equal(plain.baseSha, advancedBase)
			assert.equal(plain.diffHead, mergeSha)
			assert.equal(plain.stackedOn, null)

			// --pr-head defaults to --head, so a plain pull request keeps the same decision.
			const sameHead = resolveCiInvocation(repository, advancedBase, mergeSha, mergeSha, [], "main")
			assert.equal(sameHead.diffHead, mergeSha)
			assert.equal(sameHead.stackedOn, null)

			// A unit branch that is itself a merge commit is not a single unit delta, so the fallback
			// stays the event base even when one of its parents is an open pull request head.
			run("checkout", "--quiet", "-b", "unit-3", advancedBase)
			write("packages/core/src/unit3.ts", "export const unit3 = () => 3\n")
			run("add", ".")
			run("commit", "--quiet", "-m", "unit 3")
			run("merge", "--no-ff", "--quiet", "-m", "unit merge", parentSha)
			const multiParentHead = run("rev-parse", "HEAD")
			assert.equal(
				run("rev-list", "--parents", "-n", "1", multiParentHead).trim().split(/\s+/).slice(1).length,
				2,
			)
			const multi = resolveStackedUnitBase(
				repository,
				advancedBase,
				multiParentHead,
				[{ number: 1, headSha: parentSha, draft: false, baseRef: "main" }],
				"main",
			)
			assert.equal(multi.baseSha, advancedBase)
			assert.equal(multi.stackedOn, null)
			assert.equal(
				resolveCiInvocation(
					repository,
					advancedBase,
					multiParentHead,
					multiParentHead,
					[{ number: 1, headSha: parentSha, draft: false, baseRef: "main" }],
					"main",
				).stackedOn,
				null,
			)

			// The guard, not the map lookup, has to reject this merge: its FIRST parent is the open
			// pull request head. Without the parents.length guard that match would win, the merge would
			// be treated as a one-commit unit, and only the second-parent delta would be charged.
			const mergeTree = run("rev-parse", `${parentSha}^{tree}`)
			const firstParentOpenPrMerge = run(
				"commit-tree",
				mergeTree,
				"-p",
				parentSha,
				"-p",
				advancedBase,
				"-m",
				"unit merge with the open pull request head first",
			)
			assert.equal(
				run("rev-list", "--parents", "-n", "1", firstParentOpenPrMerge).trim().split(/\s+/).slice(1)[0],
				parentSha,
			)
			const firstParentLookup = resolveStackedUnitBase(
				repository,
				advancedBase,
				firstParentOpenPrMerge,
				[{ number: 1, headSha: parentSha, draft: false, baseRef: "main" }],
				"main",
			)
			assert.equal(firstParentLookup.baseSha, advancedBase)
			assert.equal(firstParentLookup.stackedOn, null)
		} finally {
			fs.rmSync(repository, { recursive: true, force: true })
		}
	})

	it("aligns the working tree to the diff head so selection and mutation see one tree", () => {
		const { repository, eventBaseSha, parentSha, childSha, run, write } = createSyntheticStack()

		try {
			run("checkout", "--quiet", "-b", "merge-branch", eventBaseSha)
			// The base advance changes a file, so the merge tree differs from the unit tree. The
			// selectors are derived from the unit tree, so mutation has to run on that same tree.
			write("packages/core/src/unrelated.ts", "export const unrelated = () => 99\n")
			run("add", ".")
			run("commit", "--quiet", "-m", "base advance")
			const advancedBase = run("rev-parse", "HEAD")
			run("merge", "--no-ff", "--quiet", "-m", "merge", childSha)
			const mergeSha = run("rev-parse", "HEAD")

			const invocation = resolveCiInvocation(
				repository,
				advancedBase,
				mergeSha,
				childSha,
				[{ number: 1, headSha: parentSha, draft: false, baseRef: "main" }],
				"main",
			)
			assert.equal(invocation.diffHead, childSha)
			assert.equal(run("rev-parse", "HEAD").toLowerCase(), mergeSha.toLowerCase())

			assert.equal(alignExecutionTree(repository, invocation.diffHead), true)
			assert.equal(run("rev-parse", "HEAD").toLowerCase(), childSha.toLowerCase())
			// The tree Stryker would mutate is now the unit tree, not the merge tree.
			assert.equal(
				fs.readFileSync(path.join(repository, "packages/core/src/unit2.ts"), "utf8").replace(/\r/g, ""),
				"export const unit2 = () => 2\n",
			)
			// Aligning again is a no-op.
			assert.equal(alignExecutionTree(repository, invocation.diffHead), false)
		} finally {
			fs.rmSync(repository, { recursive: true, force: true })
		}
	})
})

describe("aligned tree dependency manifests", () => {
	const createManifestStack = () => {
		const repository = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-manifests-"))
		try {
			const run = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim()
			const write = (filePath, contents) => {
				fs.mkdirSync(path.join(repository, path.dirname(filePath)), { recursive: true })
				fs.writeFileSync(path.join(repository, filePath), contents)
			}

			run("init", "--quiet", "--initial-branch", "main")
			run("config", "user.email", "gate@example.com")
			run("config", "user.name", "Gate")
			run("config", "commit.gpgsign", "false")

			write("pnpm-lock.yaml", "lockfileVersion: 9\n")
			write("packages/core/package.json", '{ "name": "@roo-code/core" }\n')
			write("packages/core/src/unit1.ts", "export const unit1 = () => 1\n")
			run("add", ".")
			run("commit", "--quiet", "-m", "parent unit")
			const parentSha = run("rev-parse", "HEAD")

			return { repository, parentSha, run, write }
		} catch (error) {
			fs.rmSync(repository, { recursive: true, force: true })
			throw error
		}
	}

	it("reports no drift when the stacked unit changes no dependency declaration", () => {
		const { repository, parentSha, run, write } = createManifestStack()

		try {
			write("packages/core/src/unit2.ts", "export const unit2 = () => 2\n")
			run("add", ".")
			run("commit", "--quiet", "-m", "unit 2 source change")
			const childSha = run("rev-parse", "HEAD")

			// The toolchain installed from the merge commit is the toolchain the aligned tree declares,
			// so nothing has to be reinstalled.
			assert.deepEqual(dependencyManifestDrift(repository, parentSha, childSha), [])
		} finally {
			fs.rmSync(repository, { recursive: true, force: true })
		}
	})

	it("reports every dependency declaration a stacked unit changes under any package", () => {
		const { repository, parentSha, run, write } = createManifestStack()

		try {
			write("packages/core/package.json", '{ "name": "@roo-code/core", "version": "0.0.1" }\n')
			run("add", ".")
			run("commit", "--quiet", "-m", "unit 2 manifest change")
			const manifestSha = run("rev-parse", "HEAD")
			assert.deepEqual(dependencyManifestDrift(repository, parentSha, manifestSha), [
				"packages/core/package.json",
			])

			write("pnpm-lock.yaml", "lockfileVersion: 9\nimporters: {}\n")
			run("add", ".")
			run("commit", "--quiet", "-m", "unit 3 lockfile change")
			const lockfileSha = run("rev-parse", "HEAD")
			assert.deepEqual(dependencyManifestDrift(repository, parentSha, lockfileSha), [
				"packages/core/package.json",
				"pnpm-lock.yaml",
			])
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

	it("names the parent pull request when the unit was measured against a stacked base", () => {
		const rows = [
			{
				id: "extension",
				changedLines: 12,
				valid: 3,
				killed: 3,
				timeout: 0,
				survived: 0,
				noCoverage: 0,
				blocking: [],
				result: "Pass",
			},
		]
		const summary = formatSummary(rows, [], { stackedOn: 1914 })
		assert.ok(summary.includes("Stacked unit: measured against the head of parent PR #1914, not the event base."))

		// A plain pull request has no stacked base, so the notice must not appear.
		const plain = formatSummary(rows, [], { stackedOn: null })
		assert.ok(!plain.includes("Stacked unit"))
		assert.ok(plain.includes("## Changed-code mutation testing"))
	})

	it("prints the pull-request-head checkout a stacked reproduction needs", () => {
		const rows = [
			{
				id: "extension",
				changedLines: 12,
				valid: 3,
				killed: 3,
				timeout: 0,
				survived: 0,
				noCoverage: 0,
				blocking: [],
				result: "Pass",
			},
		]
		const baseSha = "a".repeat(40)
		const prHeadSha = "b".repeat(40)

		// CI aligned the working tree to the pull request head before mutating, so the reproduction has
		// to say so; otherwise the same command selects the unit's lines from the unit diff but mutates
		// the merge-commit tree.
		const stacked = formatSummary(rows, [], { stackedOn: 1914, baseSha, headSha: prHeadSha })
		assert.ok(stacked.includes("checked out at the pull request head"))
		assert.ok(stacked.includes("git checkout " + prHeadSha))
		assert.ok(stacked.includes("node scripts/stryker-diff.mjs ci --base " + baseSha + " --head " + prHeadSha))

		// A plain pull request was measured on the merge commit, which is what CI already has checked
		// out, so no checkout step belongs in its reproduction.
		const plain = formatSummary(rows, [], { stackedOn: null, baseSha, headSha: "c".repeat(40) })
		assert.ok(!plain.includes("git checkout"))
		assert.ok(plain.includes("node scripts/stryker-diff.mjs ci --base " + baseSha + " --head " + "c".repeat(40)))
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
