#!/usr/bin/env node

// Conservative change-based validation classifier (issue #2291).
//
// Classifies the full changed-file range of a pull request as
// "docs-only" (safe to skip expensive comprehensive validation) or
// "full" (run everything). The classification is fail-safe: every
// uncertain input — unknown paths, unrecognized change statuses,
// missing history, malformed git output, empty ranges — selects full
// validation. Only an explicit allowlist of documentation-only files
// whose contents are not build, runtime, or test inputs can produce
// "docs-only", and only for pull_request events.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Exact repository files that are pure documentation. Enumerated
// individually so an unexpected new root-level markdown file (for
// example a release-affecting CHANGELOG.md) never matches by accident.
const DOCS_ONLY_FILES = [
	{ path: "README.md", description: "root readme" },
	{ path: "CONTRIBUTING.md", description: "contributor guide" },
	{ path: "SECURITY.md", description: "security policy" },
	{ path: "PRIVACY.md", description: "privacy notice" },
	{ path: "CODE_OF_CONDUCT.md", description: "code of conduct" },
]

// Directories where only Markdown files qualify. Everything else under
// these prefixes (images, configs, scripts) still selects full
// validation.
const DOCS_ONLY_MARKDOWN_PREFIXES = [
	{ prefix: "docs/", description: "documentation tree" },
	{ prefix: ".github/", description: "repository templates" },
]

// Defense in depth: these path segments mark files that may be loaded
// by builds, tests, or examples even when they sit under an allowlisted
// prefix. A Markdown file inside a fixtures or examples directory is a
// build/runtime/test input, so it must never allow a skip.
const NEVER_SKIP_SEGMENTS = [
	"fixtures",
	"__tests__",
	"__mocks__",
	"test-utils",
	"snapshots",
	"__snapshots__",
	"generated",
	"examples",
	"testdata",
]

// Statuses understood from `git diff --name-status`. Any other letter
// (including C for copies and X for unknown) is unrecognized and fails
// safe to full validation.
const KNOWN_STATUSES = new Set(["A", "M", "D", "R", "T"])

export const SKIP_ELIGIBLE_EVENT = "pull_request"

export const OUTPUT_REASONS = {
	"non-pr-event": "Only pull_request events may skip; merge queue, push, and scheduled runs keep full validation.",
	"empty-change-range": "The change range contained no files; an empty enumeration is treated as uncertain.",
	"unrecognized-status": "The diff contained a change status the classifier does not understand.",
	"non-documentation-path": "The change range contained paths outside the documentation-only allowlist.",
	"protected-path-segment":
		"An allowlisted path contained a protected segment (fixtures, tests, generated, examples).",
	"missing-base": "The merge base could not be resolved from repository history.",
	"classifier-failure": "The classifier could not enumerate the change range.",
	"override-label": "Full validation was forced by the ci:full-validation pull request label.",
	"override-variable": "Full validation was forced by the ZOO_CODE_REQUIRE_FULL_VALIDATION repository variable.",
}

export function allowlistFingerprint() {
	return createHash("sha256")
		.update(
			JSON.stringify({
				files: DOCS_ONLY_FILES,
				prefixes: DOCS_ONLY_MARKDOWN_PREFIXES,
				never: NEVER_SKIP_SEGMENTS,
			}),
		)
		.digest("hex")
		.slice(0, 12)
}

function hasProtectedSegment(filePath) {
	return NEVER_SKIP_SEGMENTS.some((segment) => filePath.split("/").includes(segment))
}

export function isDocsOnlyPath(filePath) {
	if (typeof filePath !== "string" || filePath.length === 0) return false
	const normalized = path.posix.normalize(filePath)
	if (normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return false
	if (hasProtectedSegment(normalized)) return false
	if (DOCS_ONLY_FILES.some((entry) => entry.path === normalized)) return true
	if (!normalized.endsWith(".md")) return false
	return DOCS_ONLY_MARKDOWN_PREFIXES.some((entry) => normalized.startsWith(entry.prefix))
}

// Parses `git diff --name-status -z --find-renames` output. Mirrors the
// parser in scripts/stryker-diff.mjs (rename and copy entries carry the
// old and the new path; all other statuses carry one path) but stays
// self-contained so classification can run without installed
// dependencies.
export function parseNameStatus(output) {
	const tokens = output.split("\0")
	const entries = []

	for (let index = 0; index < tokens.length;) {
		const statusToken = tokens[index++]
		if (!statusToken) break

		const status = statusToken[0]
		if (status === "R" || status === "C") {
			const oldPath = tokens[index++]
			const newPath = tokens[index++]
			if (!oldPath || !newPath) throw new Error(`Malformed git name-status entry: ${statusToken}`)
			entries.push({ status, oldPath, path: newPath })
		} else {
			const filePath = tokens[index++]
			if (!filePath) throw new Error(`Malformed git name-status entry: ${statusToken}`)
			entries.push({ status, path: filePath })
		}
	}

	return entries
}

function underAllowlistedPrefix(filePath) {
	return DOCS_ONLY_MARKDOWN_PREFIXES.some((entry) => filePath.startsWith(entry.prefix))
}

// Pure classification over an already-parsed change list. Unknown
// statuses, empty ranges, and any non-allowlisted path fail safe to
// full validation.
export function classifyEntries(entries) {
	if (entries.length === 0) {
		return { category: "full", reasonCode: "empty-change-range", changedFiles: 0, docsFiles: [], otherFiles: [] }
	}

	if (entries.some((entry) => !KNOWN_STATUSES.has(entry.status[0]))) {
		return {
			category: "full",
			reasonCode: "unrecognized-status",
			changedFiles: entries.length,
			docsFiles: [],
			otherFiles: entries.map(({ path: filePath }) => filePath),
		}
	}

	const docsFiles = []
	const otherFiles = []

	for (const entry of entries) {
		const paths = [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])]
		for (const filePath of paths) {
			const target = isDocsOnlyPath(filePath) ? docsFiles : otherFiles
			target.push({ status: entry.status, path: filePath })
		}
	}

	if (otherFiles.length > 0) {
		const offendingPaths = otherFiles.map(({ path: filePath }) => filePath)
		const allProtected = offendingPaths.every(
			(filePath) => hasProtectedSegment(filePath) && underAllowlistedPrefix(filePath),
		)
		return {
			category: "full",
			reasonCode: allProtected ? "protected-path-segment" : "non-documentation-path",
			changedFiles: entries.length,
			docsFiles,
			otherFiles,
			offendingPaths: offendingPaths.slice(0, 5),
		}
	}

	return { category: "docs-only", reasonCode: "allowlisted-documentation", changedFiles: entries.length, docsFiles }
}

// Classification result for a whole event. Non-pull_request events are
// never skip-eligible; the range is still computed for observability.
export function classifyEvent({ eventName, entries, forceFullReasonCode }) {
	const result = classifyEntries(entries)
	const skipEligible = eventName === SKIP_ELIGIBLE_EVENT

	if (!skipEligible) {
		return { ...result, category: "full", reasonCode: "non-pr-event" }
	}
	if (forceFullReasonCode && OUTPUT_REASONS[forceFullReasonCode]) {
		return { ...result, category: "full", reasonCode: forceFullReasonCode }
	}
	return result
}

function git(repoRoot, args) {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 })
}

export function resolveCommits(repoRoot, baseSha, headSha) {
	if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(headSha)) {
		throw new Error("Base and head must be full 40-character commit SHAs")
	}
	for (const [label, sha] of [
		["base", baseSha],
		["head", headSha],
	]) {
		try {
			git(repoRoot, ["cat-file", "-e", `${sha}^{commit}`])
		} catch (error) {
			throw new Error(`Could not resolve ${label} commit ${sha} in the checkout (shallow or missing history)`)
		}
	}
	return { baseSha, headSha }
}

export function changedEntries(repoRoot, baseSha, headSha) {
	resolveCommits(repoRoot, baseSha, headSha)
	let mergeBase
	try {
		mergeBase = git(repoRoot, ["merge-base", baseSha, headSha]).trim()
		git(repoRoot, ["merge-base", "--is-ancestor", mergeBase, headSha])
	} catch (error) {
		throw new Error("Could not resolve a common merge base between the base and head commits")
	}
	const nameStatus = git(repoRoot, ["diff", "--name-status", "-z", "--find-renames", `${mergeBase}...${headSha}`])
	const entries = parseNameStatus(nameStatus)
	return { mergeBase, entries }
}

function writeOutput(name, value) {
	if (!process.env.GITHUB_OUTPUT) return
	fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

function escapeSummaryCell(value) {
	return String(value).replaceAll("|", "\\|").replaceAll("\n", " ")
}

export function formatSummary(result, { eventName, mergeBase, headSha } = {}) {
	const lines = [
		"## Change-based validation classification",
		"",
		"| Field | Value |",
		"| --- | --- |",
		`| Event | ${escapeSummaryCell(eventName ?? "unknown")} |`,
		`| Category | ${escapeSummaryCell(result.category)} |`,
		`| Reason | ${escapeSummaryCell(OUTPUT_REASONS[result.reasonCode] ?? result.reasonCode)} |`,
		`| Changed files | ${result.changedFiles} |`,
		`| Allowlist fingerprint | ${allowlistFingerprint()} |`,
	]
	if (headSha) lines.push(`| Head | ${headSha.slice(0, 12)} |`)
	if (mergeBase) lines.push(`| Merge base | ${mergeBase.slice(0, 12)} |`)
	lines.push("")

	if (result.category === "docs-only") {
		lines.push(
			"Every changed file matches the documentation-only allowlist. Comprehensive PR validation jobs are skipped; the validation gate verifies this decision.",
			"",
			"<details><summary>Allowlisted files</summary>",
			"",
		)
		for (const { path: filePath } of result.docsFiles) lines.push(`- \`${filePath}\``)
		lines.push("", "</details>")
	} else if (result.reasonCode === "non-pr-event") {
		lines.push(
			"Full validation runs unchanged for this event. Merge-queue, release, and push validation is never reduced by classification.",
		)
	} else {
		lines.push("Full validation runs because the change range is not proven documentation-only.")
		const details = result.offendingPaths ?? result.docsFiles.map(({ path: filePath }) => filePath)
		if (details.length > 0) {
			lines.push("", "<details><summary>Paths outside or straddling the allowlist</summary>", "")
			for (const filePath of details) lines.push(`- \`${filePath}\``)
			lines.push("", "</details>")
		}
	}
	return `${lines.join("\n")}\n`
}

function argument(name) {
	const index = process.argv.indexOf(name)
	return index === -1 ? undefined : process.argv[index + 1]
}

function repoRootFromArgv() {
	return path.resolve(argument("--repo-root") ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))
}

function emitResult(result, context) {
	writeOutput("category", result.category)
	writeOutput("reason-code", result.reasonCode)
	writeOutput("reason", OUTPUT_REASONS[result.reasonCode] ?? result.reasonCode)
	writeOutput("changed-files", String(result.changedFiles))
	writeOutput("allowlist-fingerprint", allowlistFingerprint())
	console.log(
		`Change classification: ${result.category} (${result.reasonCode}), ${result.changedFiles} changed file(s)`,
	)
	if (process.env.GITHUB_STEP_SUMMARY) {
		fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatSummary(result, context))
	}
}

// Walks first-parent history and classifies each commit as if it were a
// pull request change range. Used to validate the allowlist against
// representative historical changes before skips are trusted.
export function runHistory(repoRoot, { limit = 200 } = {}) {
	const log = git(repoRoot, ["log", "--first-parent", `--max-count=${limit}`, "--format=%H%x09%s"])
	const commits = log
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha, subject] = line.split("\t")
			const prMatch = /\(#(\d+)\)$/.exec(subject) ?? /Merge pull request #(\d+) from/.exec(subject)
			return { sha, subject, pr: prMatch ? Number(prMatch[1]) : undefined }
		})

	const rows = []
	for (const commit of commits) {
		const parents = git(repoRoot, ["rev-list", "--parents", "-n", "1", commit.sha]).trim().split(/\s+/)
		const baseSha = parents[1]
		if (!baseSha) continue
		try {
			const { entries } = changedEntries(repoRoot, baseSha, commit.sha)
			const result = classifyEvent({ eventName: SKIP_ELIGIBLE_EVENT, entries })
			rows.push({ ...commit, baseSha, ...result })
		} catch (error) {
			rows.push({
				...commit,
				baseSha,
				category: "classifier-failure",
				reasonCode: error.message,
				changedFiles: 0,
			})
		}
	}
	return rows
}

function formatHistory(rows) {
	const skipCount = rows.filter((row) => row.category === "docs-only").length
	const lines = [
		`Classified ${rows.length} first-parent commit(s); ${skipCount} would skip comprehensive validation.`,
		"",
		"| Commit | PR | Category | Reason | Files | Proposed skip file list |",
		"| --- | --- | --- | --- | ---: | --- |",
	]
	for (const row of rows) {
		const skipList =
			row.category === "docs-only"
				? (row.docsFiles ?? [])
						.map(({ path: filePath }) => `\`${filePath}\``)
						.join(", ")
						.slice(0, 180)
				: ""
		lines.push(
			`| ${row.sha.slice(0, 12)} | ${row.pr ?? "—"} | ${row.category} | ${escapeSummaryCell(row.reasonCode)} | ${row.changedFiles} | ${skipList} |`,
		)
	}
	return `${lines.join("\n")}\n`
}

function main() {
	const repoRoot = repoRootFromArgv()
	const command = process.argv[2]

	if (command === "ci") {
		const eventName = argument("--event")
		const headSha = argument("--head")
		if (!eventName || !headSha)
			throw new Error(
				"Usage: change-classification.mjs ci --event <name> --head <sha> [--repo-root <path>] [--force-full-label] [--force-full-variable]",
			)
		const baseSha = argument("--base") ?? git(repoRoot, ["rev-parse", `${headSha}^1`]).trim()
		const forceFullReasonCode = process.argv.includes("--force-full-label")
			? "override-label"
			: process.argv.includes("--force-full-variable")
				? "override-variable"
				: undefined
		const { mergeBase, entries } = changedEntries(repoRoot, baseSha, headSha)
		const result = classifyEvent({ eventName, entries, forceFullReasonCode })
		emitResult(result, { eventName, mergeBase, headSha })
		return
	}

	if (command === "history") {
		const limit = Number(argument("--limit") ?? 200)
		const rows = runHistory(repoRoot, { limit })
		const output = argument("--output")
		if (output) {
			fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true })
			fs.writeFileSync(path.resolve(output), formatHistory(rows))
			fs.writeFileSync(path.resolve(output).replace(/\.md$/, ".json"), JSON.stringify(rows, null, 2))
			console.log(`History classification written to ${output}`)
		} else {
			process.stdout.write(formatHistory(rows))
		}
		return
	}

	throw new Error("Usage: change-classification.mjs <ci|history> [options]")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main()
	} catch (error) {
		console.error(`::error title=Change classification::${String(error.message).replaceAll("\n", " ")}`)
		console.error(`Change classification failed: ${error.message}`)
		process.exitCode = 1
	}
}
