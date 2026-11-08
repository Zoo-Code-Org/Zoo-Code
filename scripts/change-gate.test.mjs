import assert from "node:assert/strict"
import { parse } from "yaml"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

import {
	collectJobMetrics,
	evaluateGate,
	expectedResult,
	parseWatchSpec,
	parseClassifierStdout,
	renderGateSummary,
} from "./change-gate.mjs"

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

	for (const result of ["skipped", "cancelled", "queued", undefined]) {
		it(`rejects classification result ${result}`, () => {
			const evaluation = evaluateGate({
				needs: needsFor({ cheap: "success", expensive: "success" }, { result }),
				watched,
				eventName: "pull_request",
			})
			assert.equal(evaluation.ok, false)
			assert.match(
				evaluation.violations.join("; "),
				result === undefined
					? /result is missing/
					: result === "queued"
						? /non-terminal result/
						: /must either succeed or fail/,
			)
		})
	}
	it("does not trust docs-only outputs leaked by a failed classifier", () => {
		const evaluation = evaluateGate({
			needs: needsFor(
				{ cheap: "success", expensive: "skipped" },
				{ result: "failure", outputs: { category: "docs-only" } },
			),
			watched,
			eventName: "pull_request",
		})
		assert.equal(evaluation.ok, false)
		assert.equal(evaluation.docsOnly, false)
	})
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

	it("rejects a docs-only result when validation policy changed despite a matching replay", () => {
		const evaluation = evaluateGate({
			needs: needsFor(
				{ cheap: "success", expensive: "skipped" },
				{ result: "success", outputs: { category: "docs-only", "reason-code": "allowlisted-documentation" } },
			),
			watched,
			eventName: "pull_request",
			policyChanged: true,
			classifierReplay: {
				status: 0,
				classification: { category: "docs-only", reasonCode: "allowlisted-documentation" },
			},
		})
		assert.equal(evaluation.ok, false)
		assert.ok(evaluation.violations.some((violation) => violation.includes("Validation policy changed")))
	})

	it("accepts policy changes when full validation ran", () => {
		const evaluation = evaluateGate({
			needs: needsFor({ cheap: "success", expensive: "success" }),
			watched,
			eventName: "pull_request",
			policyChanged: true,
		})
		assert.equal(evaluation.ok, true)
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

	for (const classification of [
		{ category: "full", reasonCode: "different" },
		{ category: "docs-only", reasonCode: "non-documentation-path" },
	]) {
		it(`rejects independent replay mismatch ${JSON.stringify(classification)}`, () => {
			const evaluation = evaluateGate({
				needs: needsFor({ cheap: "success", expensive: "success" }),
				watched,
				eventName: "pull_request",
				prDraft: false,
				classifierReplay: {
					status: 0,
					classification: classification,
				},
			})
			assert.ok(!evaluation.ok)
			assert.ok(evaluation.violations.some((violation) => violation.includes("replay disagrees")))
		})
	}

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
			{ id: "compile", rule: "always", gated: false },
			{ id: "build-vsix", rule: "pr-only", gated: true, prOnlyCondition: true },
			{ id: "unit-test", rule: "always", gated: false },
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
		it(`validates ${expectation.file}`, () => {
			const workflow = parse(
				fs.readFileSync(path.join(repositoryRoot, ".github/workflows", expectation.file), "utf8"),
			)
			assert.ok(workflow.on.pull_request.types.includes("labeled"))
			assert.ok(workflow.on.pull_request.types.includes("unlabeled"))
			assert.equal(workflow.on.pull_request.paths, undefined)
			assert.equal(workflow.on.pull_request["paths-ignore"], undefined)
			assert.equal(Boolean(workflow.on.merge_group), expectation.hasMergeGroup)
			const jobs = workflow.jobs
			assert.deepEqual(
				Object.keys(jobs).sort(),
				["classify", "validation-gate", ...expectation.jobs.map((job) => job.id)].sort(),
			)
			const gate = jobs["validation-gate"]
			assert.equal(gate.if, "always()")
			assert.deepEqual([...gate.needs].sort(), ["classify", ...expectation.jobs.map((job) => job.id)].sort())
			const step = gate.steps.find((step) => step.name === "Run validation gate")
			assert.equal(
				step.env.WATCHED_JOBS,
				expectation.jobs.map((job) => `${job.id}:${job.rule}:${job.gated ? "gated" : "ungated"}`).join(","),
			)
			assert.equal(step.env.NEEDS_JSON, "${{ toJSON(needs) }}")
			assert.equal(step.env.EVENT_NAME, "${{ github.event_name }}")
			assert.match(step.env.FORCE_FULL_LABEL, /ci:full-validation/)
			assert.match(step.env.FORCE_FULL_VARIABLE, /ZOO_CODE_REQUIRE_FULL_VALIDATION/)
			const classify = jobs.classify
			const classifyStep = classify.steps.find((step) => step.id === "classify")
			assert.equal(classify.steps[0].with["fetch-depth"], 0)
			assert.equal(classifyStep.uses, "./.github/actions/classify-changes")
			assert.equal(classifyStep.with["event-name"], "${{ github.event_name }}")
			assert.equal(classifyStep.with["head-sha"], "${{ github.sha }}")
			assert.equal(classifyStep.with["force-full-label"], step.env.FORCE_FULL_LABEL)
			assert.equal(classifyStep.with["force-full-variable"], step.env.FORCE_FULL_VARIABLE)
			assert.equal(gate.permissions.actions, "read")
			assert.equal(gate.steps[0].with["fetch-depth"], 0)
			assert.match(step.run, /node scripts\/change-gate\.mjs ci/)
			for (const job of expectation.jobs) {
				if (job.gated) {
					assert.equal(jobs[job.id].needs, "classify")
					for (const term of GATING_TERMS) assert.ok(jobs[job.id].if.includes(term))
					assert.ok(
						jobs[job.id].if.includes(
							job.prOnlyCondition
								? "github.event_name == 'pull_request'"
								: "github.event_name != 'pull_request'",
						),
					)
				}
			}
			for (const id of ["classify", "validation-gate"])
				assert.equal(jobs[id].name, `${id} (${expectation.file.replace(/\.yml$/, "")})`)
		})
	}
	it("keeps required compile and matrix checks while gating expensive steps", () => {
		const { jobs } = parse(fs.readFileSync(path.join(repositoryRoot, ".github/workflows/code-qa.yml"), "utf8"))
		assert.equal(jobs.compile.name, undefined)
		assert.equal(jobs["unit-test"].name, "platform-unit-test (${{ matrix.name }})")
		assert.deepEqual(jobs.compile.needs, ["classify", "format-check"])
		assert.equal(jobs.compile.steps[0].env.FORMAT_RESULT, "${{ needs.format-check.result }}")
		assert.equal(jobs.compile.steps[0].run, 'test "$FORMAT_RESULT" = success')
		assert.ok(jobs["format-check"].steps.some((step) => step.run === "pnpm format:check"))
		assert.ok(jobs["format-check"].steps.some((step) => step.run === "pnpm test:change-gate"))
		for (const id of ["compile", "unit-test"]) {
			assert.equal(jobs[id].if, "${{ !cancelled() }}")
			assert.equal(
				jobs[id].env.RUN_VALIDATION,
				"${{ needs.classify.result != 'success' || github.event_name != 'pull_request' || needs.classify.outputs.category != 'docs-only' }}",
			)
			for (const step of jobs[id].steps.slice(1))
				assert.ok(step.if.includes("env.RUN_VALIDATION == 'true'"), step.name)
		}
		assert.equal(jobs["unit-test"].steps[0].if, "env.RUN_VALIDATION == 'false'")
		assert.match(jobs["unit-test"].steps[0].run, /GITHUB_STEP_SUMMARY/)
		assert.deepEqual(
			jobs["unit-test"].strategy.matrix.include.map((entry) => entry.name),
			["ubuntu-latest", "windows-latest"],
		)
	})
})

describe("classifier stdout", () => {
	it("parses valid output and rejects malformed output", () => {
		assert.deepEqual(parseClassifierStdout("Change classification: full (override-label), 12 changed file(s)"), {
			category: "full",
			reasonCode: "override-label",
			changedFiles: 12,
		})
		for (const value of [
			undefined,
			"",
			"Change classification: full",
			"Change classification: full (reason), NaN changed file(s)",
		])
			assert.equal(parseClassifierStdout(value), undefined)
	})
})

it("collects all metrics pages", () => {
	const routes = []
	const metrics = collectJobMetrics({
		repository: "org/repo",
		runId: "123",
		fetchJson: (route) => {
			routes.push(route)
			if (!route.includes("/jobs?")) return { started_at: "2026-01-01T00:00:00Z" }
			return {
				jobs: Array.from({ length: route.endsWith("page=1") ? 100 : 1 }, (_, i) => ({
					name: `job-${i}`,
					started_at: "2026-01-01T00:00:00Z",
					completed_at: "2026-01-01T00:01:00Z",
				})),
			}
		},
	})
	assert.deepEqual(routes, [
		"repos/org/repo/actions/runs/123",
		"repos/org/repo/actions/runs/123/jobs?per_page=100&page=1",
		"repos/org/repo/actions/runs/123/jobs?per_page=100&page=2",
	])
	assert.equal(metrics.perJob.length, 101)
	assert.equal(metrics.totalRunnerMinutes, 101)
})
