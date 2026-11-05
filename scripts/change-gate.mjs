#!/usr/bin/env node

// Always-running validation gate for change-based CI (issue #2291).
//
// The gate runs after the classification and every validation job of its
// workflow and rejects incoherent outcomes:
//   - a missing, malformed, or non-terminal classification,
//   - validation jobs that did not run when full validation was required,
//   - validation jobs that ran when a documentation-only skip was expected,
//   - a classifier replay that disagrees with the recorded classification.
//
// It also records the observability contract: classified category, the
// skipped work with explanations, runner minutes per job, and the time
// until the gate completed.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const WATCH_RULES = new Set(["always", "pr-only", "pr-non-draft"])
const TERMINAL_RESULTS = new Set(["success", "failure", "skipped", "cancelled"])

export const SKIP_EXPLANATION =
	"Documentation-only change: every changed file matches the allowlist, so this job skipped expensive validation."
export const FALLBACK_EXPLANATION = "Classification was unavailable, so the fail-safe default selected full validation."

// `name:rule:gated` triples describing the jobs this gate watches.
export function parseWatchSpec(spec) {
	if (typeof spec !== "string" || spec.trim().length === 0) throw new Error("WATCHED_JOBS is empty")
	return spec.split(",").map((entry) => {
		const parts = entry.trim().split(":")
		if (parts.length !== 3) throw new Error(`Malformed watch entry: ${entry}`)
		const [name, rule, gated] = parts
		if (!WATCH_RULES.has(rule)) throw new Error(`Unknown watch rule in entry: ${entry}`)
		if (gated !== "gated" && gated !== "ungated") throw new Error(`Unknown gating flag in entry: ${entry}`)
		return { name, rule, gated: gated === "gated" }
	})
}

export function isDocsOnlySkip(needsEntry, eventName) {
	return (
		needsEntry?.result === "success" &&
		needsEntry?.outputs?.category === "docs-only" &&
		eventName === "pull_request"
	)
}

export function expectedResult({ rule, gated }, { eventName, prDraft, docsOnly }) {
	if (rule === "pr-only" && eventName !== "pull_request") return "skipped"
	if (rule === "pr-non-draft" && eventName === "pull_request" && prDraft) return "skipped"
	if (docsOnly && gated && eventName === "pull_request") return "skipped"
	return "success"
}

function explanationFor(expected, { docsOnly, classificationFailed }) {
	if (expected === "skipped") return docsOnly ? SKIP_EXPLANATION : "Job has its own event or draft condition."
	if (classificationFailed) return FALLBACK_EXPLANATION
	return "Full validation ran."
}

// Compares the needs graph with the outcome implied by the
// classification. Missing results, failed full validation, and jobs
// whose skip state contradicts the classification are all violations.
export function evaluateGate({ needs, watched, eventName, prDraft, classifierReplay }) {
	const violations = []
	const notes = []

	const classify = needs?.classify
	if (!classify || typeof classify.result !== "string") {
		violations.push("Classification job result is missing from the needs graph.")
	} else if (!TERMINAL_RESULTS.has(classify.result)) {
		violations.push(`Classification job reported non-terminal result: ${classify.result}`)
	} else if (classify.result !== "success" && classify.result !== "failure") {
		violations.push(`Classification must either succeed or fail; got: ${classify.result}`)
	}

	const classificationFailed = classify?.result === "failure"
	if (classify?.result === "success") {
		const category = classify.outputs?.category
		if (category !== "docs-only" && category !== "full") {
			violations.push(`Classification output category is malformed: ${category}`)
		}
	}

	const docsOnly = isDocsOnlySkip(classify, eventName)

	if (classifierReplay) {
		if (classifierReplay.status === 0) {
			const replay = classifierReplay.classification
			if (classify?.result === "failure") {
				violations.push(
					"The gate reproduced a classification the classify job reported as failed; the runs are inconsistent.",
				)
			} else if (
				replay?.category !== classify?.outputs?.category ||
				replay?.reasonCode !== classify?.outputs?.["reason-code"]
			) {
				violations.push(
					`Classifier replay disagrees with the recorded classification: replay=${replay?.category}/${replay?.reasonCode} recorded=${classify?.outputs?.category}/${classify?.outputs?.["reason-code"]}`,
				)
			}
		} else if (classify?.result === "success") {
			violations.push(
				"The gate could not reproduce the classification that the classify job reported; refusing to trust the recorded category.",
			)
		} else {
			notes.push(
				"Both the classify job and the gate replay failed; full validation ran by the fail-safe default.",
			)
		}
	}

	const rows = []
	for (const job of watched) {
		const actual = needs?.[job.name]?.result
		const expected = expectedResult(job, { eventName, prDraft, docsOnly })
		const ok = actual === expected
		if (!actual) {
			violations.push(`Watched job ${job.name} has no result in the needs graph (missing or misnamed).`)
		} else if (!ok) {
			violations.push(
				expected === "success"
					? `Required validation missing: ${job.name} reported "${actual}" but full validation was required.`
					: `Unexpected run: ${job.name} reported "${actual}" but the classification expected it to be skipped.`,
			)
		}
		rows.push({
			...job,
			expected,
			actual: actual ?? "missing",
			ok,
			explanation: explanationFor(expected, { docsOnly, classificationFailed }),
		})
	}

	return { ok: violations.length === 0, violations, notes, rows, docsOnly, classificationFailed }
}

// Best-effort runner-minute metrics from the Actions API. `fetchJson`
// is injectable for tests.
export function collectJobMetrics({ repository, runId, fetchJson }) {
	const run = fetchJson(`repos/${repository}/actions/runs/${runId}`)
	const jobs = []
	let page = 1
	for (;;) {
		const response = fetchJson(`repos/${repository}/actions/runs/${runId}/jobs?per_page=100&page=${page}`)
		jobs.push(...(response.jobs ?? []))
		if ((response.jobs ?? []).length < 100) break
		page += 1
	}

	const minutes = (start, end) => Math.max(0, (new Date(end) - new Date(start)) / 60_000)
	const perJob = jobs
		.filter((job) => job.started_at && job.completed_at)
		.map((job) => ({ name: job.name, runnerMinutes: Number(minutes(job.started_at, job.completed_at).toFixed(2)) }))
	const totalRunnerMinutes = Number(perJob.reduce((sum, job) => sum + job.runnerMinutes, 0).toFixed(2))
	const latestCompletion = jobs
		.map((job) => job.completed_at)
		.filter(Boolean)
		.sort()
		.at(-1)
	const completionMinutes =
		run?.started_at && latestCompletion ? Number(minutes(run.started_at, latestCompletion).toFixed(2)) : undefined

	return { perJob, totalRunnerMinutes, completionMinutes }
}

function escapeSummaryCell(value) {
	return String(value).replaceAll("|", "\\|").replaceAll("\n", " ")
}

export function renderGateSummary({ rows, needs, eventName, metrics, violations, notes }) {
	const classify = needs?.classify
	const lines = [
		"## Validation gate",
		"",
		"| Field | Value |",
		"| --- | --- |",
		`| Event | ${escapeSummaryCell(eventName)} |`,
		`| Classification | ${escapeSummaryCell(classify?.outputs?.category ?? "unavailable")} (${escapeSummaryCell(classify?.outputs?.["reason-code"] ?? "no reason recorded")}) |`,
		`| Classification job | ${escapeSummaryCell(classify?.result ?? "missing")} |`,
		`| Skip decision | ${rows.some((row) => row.expected === "skipped" && row.explanation === SKIP_EXPLANATION) ? "documentation-only jobs skipped" : "no classification-based skips"} |`,
		`| Gate outcome | ${violations.length === 0 ? "passed" : "failed"} |`,
		"",
		"| Job | Watch rule | Gated | Expected | Actual | Explanation |",
		"| --- | --- | --- | --- | --- | --- |",
	]
	for (const row of rows) {
		lines.push(
			`| ${escapeSummaryCell(row.name)} | ${row.rule} | ${row.gated ? "yes" : "no"} | ${row.expected} | ${escapeSummaryCell(row.actual)} | ${escapeSummaryCell(row.explanation)} |`,
		)
	}

	if (metrics) {
		lines.push(
			"",
			"| Runner metric | Minutes |",
			"| --- | ---: |",
			`| Total runner minutes (this workflow run) | ${metrics.totalRunnerMinutes} |`,
			...(metrics.completionMinutes === undefined
				? []
				: [`| Required-check completion time (run start to last job) | ${metrics.completionMinutes} |`]),
			"",
			"<details><summary>Runner minutes per job</summary>",
			"",
			"| Job | Minutes |",
			"| --- | ---: |",
			...metrics.perJob.map((job) => `| ${escapeSummaryCell(job.name)} | ${job.runnerMinutes} |`),
			"",
			"</details>",
		)
	} else {
		lines.push("", "Runner-minute metrics were unavailable for this run (best effort only).")
	}

	if (notes.length > 0) lines.push("", ...notes.map((note) => `Note: ${note}`))
	if (violations.length > 0) {
		lines.push("", "### Gate violations", "")
		for (const violation of violations) lines.push(`- ${violation}`)
	}
	return `${lines.join("\n")}\n`
}

function repositoryRoot() {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
}

export function parseClassifierStdout(stdout) {
	const match = /Change classification: (\S+) \(([^)]+)\), (\d+) changed file/.exec(stdout ?? "")
	return match ? { category: match[1], reasonCode: match[2], changedFiles: Number(match[3]) } : undefined
}

function replayClassification(repoRoot, { baseSha, headSha, eventName, forceFullLabel, forceFullVariable }) {
	const args = [
		path.join(repoRoot, "scripts/change-classification.mjs"),
		"ci",
		"--event",
		eventName,
		"--head",
		headSha,
		"--repo-root",
		repoRoot,
	]
	if (forceFullLabel === "true") args.push("--force-full-label")
	if (forceFullVariable === "true") args.push("--force-full-variable")

	const result = spawnSync(process.execPath, args, {
		cwd: repoRoot,
		encoding: "utf8",
		// The replay must not write workflow outputs or summaries.
		env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
	})
	if (result.status !== 0) return { status: result.status ?? 1, classification: undefined }

	const classification = parseClassifierStdout(result.stdout)
	return classification ? { status: 0, classification } : { status: 1, classification: undefined }
}

function argument(name) {
	const index = process.argv.indexOf(name)
	return index === -1 ? undefined : process.argv[index + 1]
}

function main() {
	const repoRoot = repositoryRoot()
	const command = process.argv[2]
	if (command !== "ci") throw new Error("Usage: change-gate.mjs ci --base <sha> --head <sha> [--skip-metrics]")

	const headSha = argument("--head")
	const baseSha = argument("--base")
	if (!headSha || !baseSha) throw new Error("--base and --head are required")

	const eventName = process.env.EVENT_NAME
	if (!eventName) throw new Error("EVENT_NAME is required")
	const watched = parseWatchSpec(process.env.WATCHED_JOBS ?? "")
	const needs = JSON.parse(process.env.NEEDS_JSON ?? "{}")

	const classifierReplay = replayClassification(repoRoot, {
		baseSha,
		headSha,
		eventName,
		forceFullLabel: process.env.FORCE_FULL_LABEL,
		forceFullVariable: process.env.FORCE_FULL_VARIABLE,
	})
	if (classifierReplay.classification === undefined && classifierReplay.status === 0) {
		classifierReplay.status = 1
	}

	const evaluation = evaluateGate({
		needs,
		watched,
		eventName,
		prDraft: process.env.PR_DRAFT === "true",
		classifierReplay: { status: classifierReplay.status, classification: classifierReplay.classification },
	})

	let metrics
	if (!process.argv.includes("--skip-metrics") && process.env.GH_TOKEN && process.env.RUN_ID) {
		try {
			metrics = collectJobMetrics({
				repository: process.env.GITHUB_REPOSITORY,
				runId: process.env.RUN_ID,
				fetchJson: (route) => {
					const result = spawnSync("gh", ["api", route], {
						encoding: "utf8",
						env: process.env,
						maxBuffer: 20 * 1024 * 1024,
					})
					if (result.status !== 0) throw new Error(result.stderr)
					return JSON.parse(result.stdout)
				},
			})
		} catch (error) {
			console.warn(
				`::warning title=Validation gate::Runner-minute metrics unavailable: ${String(error.message).replaceAll("\n", " ")}`,
			)
		}
	}

	if (process.env.GITHUB_STEP_SUMMARY) {
		fs.appendFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			renderGateSummary({ ...evaluation, needs, eventName, metrics }),
		)
	}

	for (const note of evaluation.notes) console.log(`Validation gate note: ${note}`)
	for (const violation of evaluation.violations) {
		console.error(`::error title=Validation gate::${violation.replaceAll("\n", " ")}`)
	}
	if (evaluation.ok) {
		console.log(
			`Validation gate passed: classification=${needs?.classify?.outputs?.category ?? "unavailable"}, watched=${evaluation.rows.length} job(s).`,
		)
		return
	}
	process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main()
	} catch (error) {
		console.error(`::error title=Validation gate::${String(error.message).replaceAll("\n", " ")}`)
		console.error(`Validation gate failed: ${error.message}`)
		process.exitCode = 1
	}
}
