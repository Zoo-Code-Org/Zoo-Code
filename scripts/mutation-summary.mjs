import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Build the per-file mutation summary that the mutation-testing workflow appends to the job
 * summary.
 *
 * StrykerJS has no Markdown reporter (its reporters are progress, dots, clear-text, dashboard
 * and json, plus html as a plugin), so the counts are read from the mutation.json report this
 * job already writes and the table is rendered here.
 *
 * Report contents are data, not text to display: a string reaches the summary only if it
 * passed REPORT_NAME or SAFE_RELATIVE_PATH, so no Markdown table or link character can be
 * rendered from a report, and a path that resolves outside the working directory is rejected
 * rather than shown.
 */

const REPORT_DIRECTORY = "reports/mutation"
const VALID_STATUSES = new Set(["Killed", "Survived", "NoCoverage", "Timeout"])
// Repo-relative source paths only: letters, digits and the separators a source path uses.
// A key carrying anything else (pipe, backtick, brackets, control characters, drive letters,
// leading ".." component) is rejected instead of rendered.
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._@+/-]+$/
// Package directory names in reports/mutation/<package> are simple slugs.
const REPORT_NAME = /^[A-Za-z0-9._@+-]+$/
// GitHub caps a step's job summary at 1 MiB and fails the summary upload above it, so the
// table shows the worst rows and counts the rest instead of risking the whole summary.
const MAX_SUMMARY_ROWS = 40
const BACKTICK = "`"

/** Return a report directory name for a diagnostic, or a fixed label when it is not slug-shaped. */
function renderReportName(name) {
	return REPORT_NAME.test(name) ? name : "report"
}

/**
 * Return the normalised repo-relative path for one report entry, or undefined when the entry
 * cannot be shown: non-string, empty, absolute, carrying a ".." component under either separator
 * convention, or containing a character a source path would not have.
 */
export function normalizeReportPath(filePath, projectRoot, cwd) {
	if (typeof filePath !== "string" || filePath.length === 0) return undefined
	if (projectRoot !== undefined && typeof projectRoot !== "string") return undefined
	if (filePath.includes("\u0000")) return undefined
	const absolute = path.resolve(projectRoot ?? cwd, filePath)
	const relative = path.relative(cwd, absolute).replaceAll("\\", "/")
	// Reject a rendered path that is empty, absolute, or still carries a ".." component. That
	// covers a real escape ("../outside") and the POSIX shape where "..\\..\\x" is one file name
	// inside the package and would otherwise render as "pkg/../../x". A file named "..x.ts" has
	// no ".." component and stays a file, and a package sibling that resolves inside the working
	// directory ("../sibling.ts" -> "sibling.ts") stays a repo path.
	if (relative.length === 0 || path.isAbsolute(relative) || relative.split("/").includes("..")) {
		return undefined
	}
	if (!SAFE_RELATIVE_PATH.test(relative)) return undefined
	return relative
}

/**
 * Count per-file mutants from every reports/mutation/<package>/mutation.json under reportRoot.
 *
 * Returns the Markdown lines for the summary (header included when any row is rendered), the
 * sorted rows, and the fixed diagnostics of reports that were skipped.
 */
export function summarizeMutationReports({
	reportRoot = REPORT_DIRECTORY,
	cwd = process.cwd(),
	maxRows = MAX_SUMMARY_ROWS,
} = {}) {
	const rows = []
	const unreadable = []
	let directories = []

	try {
		directories = fs.existsSync(reportRoot) ? fs.readdirSync(reportRoot, { withFileTypes: true }) : []
	} catch {
		// Raw filesystem error text is not summary content; keep a fixed diagnostic.
		unreadable.push("reports/mutation: directory could not be read")
	}

	for (const directory of directories) {
		if (!directory.isDirectory()) continue
		const reportFile = path.join(reportRoot, directory.name, "mutation.json")
		if (!fs.existsSync(reportFile)) continue
		let report
		try {
			report = JSON.parse(fs.readFileSync(reportFile, "utf8"))
		} catch {
			// The parser message can quote report content; render a fixed, bounded diagnostic.
			unreadable.push(renderReportName(directory.name) + ": invalid JSON")
			continue
		}
		if (
			report === null ||
			typeof report !== "object" ||
			report.files === null ||
			typeof report.files !== "object"
		) {
			unreadable.push(renderReportName(directory.name) + ": report has no files map")
			continue
		}
		for (const [filePath, file] of Object.entries(report.files)) {
			if (file === null || typeof file !== "object") continue
			const counts = { mutants: 0, killed: 0, survived: 0, noCoverage: 0, timeout: 0 }
			const mutants = Array.isArray(file.mutants) ? file.mutants : []
			for (const mutant of mutants) {
				if (mutant === null || typeof mutant !== "object") continue
				if (!VALID_STATUSES.has(mutant.status)) continue
				counts.mutants += 1
				if (mutant.status === "Killed") counts.killed += 1
				if (mutant.status === "Survived") counts.survived += 1
				if (mutant.status === "NoCoverage") counts.noCoverage += 1
				if (mutant.status === "Timeout") counts.timeout += 1
			}
			// Files with no counted mutants (Ignored, CompileError, net-only) have no row.
			if (counts.mutants === 0) continue
			const relative = normalizeReportPath(filePath, report.projectRoot, cwd)
			if (relative === undefined) {
				unreadable.push(renderReportName(directory.name) + ": rejected unsafe report path")
				continue
			}
			rows.push({ file: relative, ...counts })
		}
	}

	const lines = ["", "### Per-file mutation results", ""]

	if (rows.length === 0) {
		lines.push("No Stryker JSON report was produced for this run; see the step log above for the reason.")
	} else {
		rows.sort((left, right) => {
			const blocked = right.survived + right.noCoverage - (left.survived + left.noCoverage)
			return blocked === 0 ? left.file.localeCompare(right.file) : blocked
		})
		lines.push(
			"Every file below comes from the " +
				BACKTICK +
				"changed-code-mutation-report" +
				BACKTICK +
				" artifact (" +
				BACKTICK +
				"reports/mutation/<package>/mutation.json" +
				BACKTICK +
				"). Rows are sorted by Survived + NoCoverage, worst first; Score is (Killed + Timeout) / Mutants, matching Stryker's mutation score.",
			"",
			"| File | Mutants | Killed | Survived | NoCoverage | Score |",
			"| --- | ---: | ---: | ---: | ---: | ---: |",
		)
		for (const row of rows.slice(0, maxRows)) {
			// Stryker counts a Timeout mutant as detected, so the mutation score numerator is
			// Killed + Timeout (the table's Killed column stays Killed-only).
			const score = (((row.killed + row.timeout) / row.mutants) * 100).toFixed(1)
			lines.push(
				"| " +
					BACKTICK +
					row.file +
					BACKTICK +
					" | " +
					row.mutants +
					" | " +
					row.killed +
					" | " +
					row.survived +
					" | " +
					row.noCoverage +
					" | " +
					score +
					"% |",
			)
		}
		if (rows.length > maxRows) {
			lines.push(
				"",
				"and " +
					(rows.length - maxRows) +
					" more file" +
					(rows.length - maxRows === 1 ? "" : "s") +
					"; see the " +
					BACKTICK +
					"changed-code-mutation-report" +
					BACKTICK +
					" artifact.",
			)
		}
		lines.push(
			"",
			"Close a surviving or uncovered mutant with a focused test that fails under the mutation; the artifact does not need to be downloaded to read this table.",
		)
	}

	if (unreadable.length > 0) lines.push("", "Unreadable report(s): " + unreadable.join("; "))

	return { lines, rows, unreadable }
}

/** Entry point used by the workflow: append the summary to GITHUB_STEP_SUMMARY (or stdout). */
export function writeMutationSummary({
	reportRoot = REPORT_DIRECTORY,
	cwd = process.cwd(),
	outputFile = process.env.GITHUB_STEP_SUMMARY,
} = {}) {
	const { lines } = summarizeMutationReports({ reportRoot, cwd })
	const summary = lines.join("\n") + "\n"
	try {
		// The runner gives each step its own summary file and reads it after the step, so a
		// plain append is the whole contract here - same shape as appendSummary() in
		// scripts/stryker-diff.mjs.
		if (outputFile) fs.appendFileSync(outputFile, summary)
		else process.stdout.write(summary)
	} catch (error) {
		console.log(
			"::warning title=Mutation test advisory::Could not write the per-file mutation summary: " + error.message,
		)
	}
	return summary
}

// When executed directly (the workflow step), write the summary for this run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	writeMutationSummary()
}
