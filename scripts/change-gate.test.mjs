import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

import { collectJobMetrics, evaluateGate, expectedResult, parseWatchSpec, renderGateSummary } from "./change-gate.mjs"

const needsFor = (results, classify) => ({
	classify: classify ?? { result: "success", outputs: { category: "full", "reason-code": "non-documentation-path" } },
	...Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { result }])),
})

describe("watch specification", () => {
	it("parses name:rule:gated triples", () => {
		assert.deepEqual(parseWatchSpec("job-a:always:gated, job-b:pr-only:ungated, job-c:pr-non-draft:gated"), [
			{ name: "job-a", rule: "always", gated: true },
			{ name: "job-b", rule: "pr-only", gated: false },
			{ name: "job-c", rule: "pr-non-draft", gated: true },
		])
	})

	it("rejects malformed specifications", () => {
		assert.throws(() => parseWatchSpec("job-a:always"))
		assert.throws(() => parseWatchSpec("job-a:sometimes:gated"))
		assert.throws(() => parseWatchSpec("job-a:always:maybe"))
		assert.throws(() => parseWatchSpec(""))
	})
})

describe("expected job outcomes", () => {
	const base = { eventName: "pull_request", prDraft: false, docsOnly: false }

	it("requires success for always-running jobs on pull requests", () => {
		assert.equal(expectedResult({ rule: "always", gated: true }, base), "success")
	})

	it("skips gated jobs only for documentation-only pull request classifications", () => {
		assert.equal(expectedResult({ rule: "always", gated: true }, { ...base, docsOnly: true }), "skipped")
	})

	it("never skips on the merge queue even when a docs-only classification is recorded", () => {
		assert.equal(
			expectedResult({ rule: "always", gated: true }, { ...base, eventName: "merge_group", docsOnly: true }),
			"success",
		)
	})

	it("expect pull-request-only jobs to be skipped on other events", () => {
		assert.equal(expectedResult({ rule: "pr-only", gated: false }, { ...base, eventName: "push" }), "skipped")
		assert.equal(expectedResult({ rule: "pr-only", gated: true }, { ...base, eventName: "merge_group" }), "skipped")
	})

	it("expect non-draft mutations to be skipped for drafts but not for the merge queue", () => {
		assert.equal(expectedResult({ rule: "pr-non-draft", gated: true }, { ...base, prDraft: true }), "skipped")
		assert.equal(
			expectedResult({ rule: "pr-non-draft", gated: true }, { ...base, eventName: "merge_group" }),
			"success",
		)
	})
})

describe("gate evaluation", () => {
	const watched = [
		{ name: "cheap", rule: "always", gated: false },
		{ name: "expensive", rule: "always", gated: true },
	]

	it("passes when full validation ran for a code change", () => {
		const evaluation = evaluateGate({
			needs: needsFor({ cheap: "success", expensive: "success" }),
			watched,
			eventName: "pull_request",
			prDraft: false,
		})
		assert.ok(evaluation.ok, evaluation.violations.join("; "))
	})

	it("passes when gated jobs skip a documentation-only change", () => {
		const evaluation = evaluateGate({
			needs: needsFor(
				{ cheap: "success", expensive: "skipped" },
				{
					result: "success",
					outputs: { category: "docs-only", "reason-code": "allowlisted-documentation" },
				},
			),
			watched,
			eventName: "pull_request",
			prDraft: false,
		})
		assert.ok(evaluation.ok, evaluation.violations.join("; "))
		assert.ok(evaluation.rows.find((row) => row.name === "expensive").explanation.includes("Documentation-only"))
	})

	it("rejects a gated job that ran despite a docs-only classification", () => {
		const evaluation = evaluateGate({
			needs: needsFor(
				{ cheap: "success", expensive: "success" },
				{
					result: "success",
					outputs: { category: "docs-only", "reason-code": "allowlisted-documentation" },
				},
			),
			watched,
			eventName: "pull_request",
			prDraft: false,
		})
		assert.ok(!evaluation.ok)
		assert.ok(evaluation.violations.some((violation) => violation.includes("expected it to be skipped")))
	})

	it("rejects missing or failed required validation", () => {
		for (const actual of ["skipped", "failure", "cancelled"]) {
			const evaluation = evaluateGate({
				needs: needsFor({ cheap: "success", expensive: actual }),
				watched,
				eventName: "pull_request",
				prDraft: false,
			})
			assert.ok(!evaluation.ok, `actual=${actual} must violate the gate`)
		}
	})

	it("rejects a missing classification job", () => {
		const evaluation = evaluateGate({
			needs: { cheap: { result: "success" }, expensive: { result: "success" } },
			watched,
			eventName: "pull_request",
			prDraft: false,
		})
		assert.ok(!evaluation.ok)
		assert.ok(evaluation.violations.some((violation) => violation.includes("missing")))
	})

	it("rejects a malformed classification category", () => {
		const evaluation = evaluateGate({
			needs: needsFor(
				{ cheap: "success", expensive: "success" },
				{
					result: "success",
					outputs: { category: "banana", "reason-code": "allowlisted-documentation" },
				},
			),
			watched,
			eventName: "pull_request",
			prDraft: false,
		})
		assert.ok(!evaluation.ok)
		assert.ok(evaluation.violations.some((violation) => violation.includes("malformed")))
	})

	it("accepts the fail-safe fallback when classification failed and full validation ran", () => {
		const evaluation = evaluateGate({
			needs: needsFor({ cheap: "success", expensive: "success" }, { result: "failure" }),
			watched,
			eventName: "pull_request",
			prDraft: false,
		})
		assert.ok(evaluation.ok, evaluation.violations.join("; "))
		assert.ok(evaluation.rows.every((row) => row.explanation.includes("fail-safe")))
	})

	it("rejects a skipped job after a failed classification", () => {
		const evaluation = evaluateGate({
			needs: needsFor({ cheap: "success", expensive: "skipped" }, { result: "failure" }),
			watched,
			eventName: "pull_request",
			prDraft: false,
		})
		assert.ok(!evaluation.ok)
		assert.ok(evaluation.violations.some((violation) => violation.includes("Required validation missing")))
	})

	it("validates the classification with a matching deterministic replay", () => {
		const evaluation = evaluateGate({
			needs: needsFor(
				{ cheap: "success", expensive: "skipped" },
				{
					result: "success",
					outputs: { category: "docs-only", "reason-code": "allowlisted-documentation" },
				},
			),
			watched,
			eventName: "pull_request",
			prDraft: false,
			classifierReplay: {
				status: 0,
				classification: { category: "docs-only", reasonCode: "allowlisted-documentation", changedFiles: "1" },
			},
		})
		assert.ok(evaluation.ok, evaluation.violations.join("; "))
	})

	it("rejects a replay that disagrees with the recorded classification", () => {
		const evaluation = evaluateGate({
			needs: needsFor({ cheap: "success", expensive: "success" }),
			watched,
			eventName: "pull_request",
			prDraft: false,
			classifierReplay: {
				status: 0,
				classification: { category: "docs-only", reasonCode: "allowlisted-documentation", changedFiles: "1" },
			},
		})
		assert.ok(!evaluation.ok)
		assert.ok(evaluation.violations.some((violation) => violation.includes("replay disagrees")))
	})

	it("rejects a replay failure when the classify job claimed success", () => {
		const evaluation = evaluateGate({
			needs: needsFor({ cheap: "success", expensive: "success" }),
			watched,
			eventName: "pull_request",
			prDraft: false,
			classifierReplay: { status: 1 },
		})
		assert.ok(!evaluation.ok)
		assert.ok(evaluation.violations.some((violation) => violation.includes("could not reproduce")))
	})

	it("reports watched jobs that are missing from the needs graph", () => {
		const evaluation = evaluateGate({
			needs: needsFor({ cheap: "success" }),
			watched,
			eventName: "pull_request",
			prDraft: false,
		})
		assert.ok(!evaluation.ok)
		assert.ok(evaluation.violations.some((violation) => violation.includes("expensive")))
	})
})

describe("runner-minute metrics", () => {
	it("sums job minutes and reports completion time from injected API pages", () => {
		const metrics = collectJobMetrics({
			repository: "Zoo-Code-Org/Zoo-Code",
			runId: 42,
			fetchJson: (route) => {
				if (route.endsWith("/jobs?per_page=100&page=1")) {
					return {
						jobs: [
							{ name: "a", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:10:00Z" },
							{ name: "b", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:05:30Z" },
						],
					}
				}
				if (route === "repos/Zoo-Code-Org/Zoo-Code/actions/runs/42") {
					return { started_at: "2026-01-01T00:00:00Z" }
				}
				throw new Error(`unexpected route: ${route}`)
			},
		})
		assert.equal(metrics.totalRunnerMinutes, 15.5)
		assert.equal(metrics.completionMinutes, 10)
	})
})

describe("summary rendering", () => {
	const watched = [
		{ name: "cheap", rule: "always", gated: false },
		{ name: "expensive", rule: "always", gated: true },
	]

	it("renders the job outcome table, metrics, and violations", () => {
		const evaluation = evaluateGate({
			needs: needsFor(
				{ cheap: "success", expensive: "skipped" },
				{
					result: "success",
					outputs: { category: "docs-only", "reason-code": "allowlisted-documentation" },
				},
			),
			watched,
			eventName: "pull_request",
			prDraft: false,
		})
		const summary = renderGateSummary({
			...evaluation,
			needs: needsFor(
				{ cheap: "success", expensive: "skipped" },
				{
					result: "success",
					outputs: { category: "docs-only", "reason-code": "allowlisted-documentation" },
				},
			),
			eventName: "pull_request",
			metrics: { perJob: [{ name: "cheap", runnerMinutes: 1.5 }], totalRunnerMinutes: 1.5, completionMinutes: 4 },
			violations: evaluation.violations,
		})
		assert.match(summary, /Validation gate/)
		assert.match(summary, /docs-only/)
		assert.match(summary, /Total runner minutes/)
		assert.match(summary, /expensive/)
	})
})

// --- Workflow wiring assertions -------------------------------------------

function jobBlock(workflow, jobId) {
	const lines = workflow.split("\n")
	const start = lines.findIndex((line) => line === `    ${jobId}:`)
	assert.ok(start !== -1, `missing job: ${jobId}`)
	let end = lines.length
	for (let index = start + 1; index < lines.length; index++) {
		if (/^    [a-z][a-z0-9-]*:$/.test(lines[index])) {
			end = index
			break
		}
	}
	return lines.slice(start + 1, end).join("\n")
}

const GATING_TERMS = [
	"!cancelled()",
	"needs.classify.result != 'success'",
	"needs.classify.outputs.category != 'docs-only'",
]

const WORKFLOW_EXPECTATIONS = [
	{
		file: "code-qa.yml",
		hasMergeGroup: true,
		jobs: [
			{ id: "dependency-review", rule: "pr-only", gated: false },
			{ id: "invisible-chars", rule: "always", gated: false },
			{ id: "format-check", rule: "always", gated: false },
			{ id: "check-translations", rule: "always", gated: true },
			{ id: "knip", rule: "always", gated: false },
			{ id: "compile", rule: "always", gated: true },
			{ id: "build-vsix", rule: "pr-only", gated: true, prOnlyCondition: true },
			{ id: "unit-test", rule: "always", gated: true },
		],
	},
	{
		file: "e2e.yml",
		hasMergeGroup: true,
		jobs: [{ id: "e2e-mock", rule: "always", gated: true }],
	},
	{
		file: "visual-regression.yml",
		hasMergeGroup: true,
		jobs: [
			{ id: "webview-visual", rule: "always", gated: true },
			{ id: "theme-fixtures", rule: "always", gated: true },
			{ id: "extension-host-visual", rule: "always", gated: true },
		],
	},
	{
		file: "mutation-testing.yml",
		hasMergeGroup: true,
		jobs: [{ id: "mutation-diff", rule: "pr-non-draft", gated: true, prOnlyCondition: false }],
	},
	{
		file: "codeql.yml",
		hasMergeGroup: false,
		jobs: [{ id: "analyze", rule: "always", gated: true }],
	},
]

describe("change-based validation workflow wiring", () => {
	for (const expectation of WORKFLOW_EXPECTATIONS) {
		describe(expectation.file, () => {
			const workflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows", expectation.file), "utf8")
			const watchedJobs = expectation.jobs
				.map((job) => `${job.id}:${job.rule}:${job.gated ? "gated" : "ungated"}`)
				.join(",")
			const watchedNames = expectation.jobs.map((job) => job.id)

			it("triggers on pull_request and merge_group without path filters", () => {
				assert.match(workflow, /^    pull_request:/m)
				assert.doesNotMatch(workflow, /^        paths(?:-ignore)?:/m)
				if (expectation.hasMergeGroup) assert.match(workflow, /^    merge_group:/m)
			})

			it("runs a classify job with full history and override wiring", () => {
				const classify = jobBlock(workflow, "classify")
				assert.match(classify, /uses: \.\/\.github\/actions\/classify-changes/)
				assert.match(classify, /fetch-depth: 0/)
				assert.match(classify, /event-name: \$\{\{ github\.event_name \}\}/)
				assert.match(classify, /ci:full-validation/)
				assert.match(classify, /ZOO_CODE_REQUIRE_FULL_VALIDATION/)
				assert.ok(!classify.includes("setup-node-pnpm"), "classify must stay a fast no-install job")
			})

			for (const job of expectation.jobs) {
				it(`${job.gated ? "gates" : "keeps"} job ${job.id} correctly`, () => {
					const block = jobBlock(workflow, job.id)
					if (job.gated) {
						assert.match(block, /needs: classify/)
						for (const term of GATING_TERMS) {
							assert.ok(block.includes(term), `${job.id} gating is missing term: ${term}`)
						}
						const eventTerm = job.prOnlyCondition
							? "github.event_name == 'pull_request'"
							: "github.event_name != 'pull_request'"
						assert.ok(block.includes(eventTerm), `${job.id} must restrict skips to pull_request events`)
					} else {
						assert.ok(!block.includes("needs: classify"), `${job.id} must not depend on classification`)
					}
				})
			}

			it("runs a validation gate that watches exactly the classification and validation jobs", () => {
				const gate = jobBlock(workflow, "validation-gate")
				assert.match(gate, /if: always\(\)/)
				assert.match(gate, /actions: read/)
				assert.match(gate, /fetch-depth: 0/)
				assert.match(gate, /node scripts\/change-gate\.mjs ci/)

				const needsMatch = gate.match(/needs:\n((?:\s+- \S+\n)+)/)
				assert.ok(needsMatch, "validation-gate must declare its needs as a list")
				const needed = [...needsMatch[1].matchAll(/- (\S+)/g)].map((match) => match[1])
				assert.deepEqual([...needed].sort(), ["classify", ...watchedNames].sort())

				const watchedMatch = gate.match(/WATCHED_JOBS: (\S+)/)
				assert.ok(watchedMatch, "validation-gate must declare WATCHED_JOBS")
				assert.equal(watchedMatch[1], watchedJobs)

				assert.match(gate, /ci:full-validation/)
				assert.match(gate, /ZOO_CODE_REQUIRE_FULL_VALIDATION/)
				assert.match(gate, /GH_TOKEN/)
			})
		})
	}

	it("moves markdown formatting into an always-running job so docs-only pull requests keep format validation", () => {
		const workflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/code-qa.yml"), "utf8")
		const compile = jobBlock(workflow, "compile")
		const formatCheck = jobBlock(workflow, "format-check")

		assert.ok(!compile.includes("pnpm format:check"), "compile must no longer run format:check")
		assert.match(formatCheck, /run: pnpm format:check/)
		assert.match(formatCheck, /run: pnpm test:change-gate/)
		assert.ok(!formatCheck.includes("needs: classify"), "format-check must always run")
	})
})
