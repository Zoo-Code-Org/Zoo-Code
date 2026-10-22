import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Build the per-file mutation summary that the mutation-testing workflow appends to the job
 * summary.
 *
 * The Stryker JSON reports are untrusted input for this script: report.files keys are file
 * paths and they are rendered into a Markdown table. Every path is therefore validated
 * (normalised repo-relative form, safe characters) and Markdown-escaped before insertion, and
 * the report shape is checked rather than assumed.
 */

const REPORT_DIRECTORY = "reports/mutation"
const VALID_STATUSES = new Set(["Killed", "Survived", "NoCoverage", "Timeout"])
// Repo-relative paths only: letters, digits and the separators/characters a source path
// normally uses. Anything else (backticks, pipes, control characters, drive letters, ...)
// is rejected instead of rendered into the summary.
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._@+/-]+$/
const BACKSLASH = String.fromCharCode(92)
const BACKTICK = String.fromCharCode(96)

/** Escape the Markdown table metacharacters and line breaks a file path could carry. */
export function escapeMarkdownCell(value) {
	return String(value)
		.split(BACKSLASH)
		.join(BACKSLASH + BACKSLASH)
		.split("|")
		.join(BACKSLASH + "|")
		.split(BACKTICK)
		.join(BACKSLASH + BACKTICK)
		.split("[")
		.join(BACKSLASH + "[")
		.split("]")
		.join(BACKSLASH + "]")
		.split("(")
		.join(BACKSLASH + "(")
		.split(")")
		.join(BACKSLASH + ")")
		.split("\r")
		.join(BACKSLASH + "r")
		.split("\n")
		.join(BACKSLASH + "n")
}

/**
 * Return the normalised repo-relative path for one report entry, or undefined when the entry
 * cannot be trusted for display.
 */
export function normalizeReportPath(filePath, projectRoot, cwd) {
	if (typeof filePath !== "string" || filePath.length === 0) return undefined
	if (projectRoot !== undefined && typeof projectRoot !== "string") return undefined
	if (filePath.includes("\u0000")) return undefined
	const absolute = path.resolve(projectRoot ?? cwd, filePath)
	const relative = path.relative(cwd, absolute).replaceAll("\\", "/")
	if (relative.length === 0 || path.isAbsolute(relative) || relative.startsWith("..")) return undefined
	if (!SAFE_RELATIVE_PATH.test(relative)) return undefined
	return relative
}

/**
 * Collect per-file mutation counts from every report under reportRoot.
 *
 * Returns the Markdown lines for the summary (including the header when any row exists) and
 * the list of unreadable reports that were skipped.
 */
export function summarizeMutationReports({ reportRoot = REPORT_DIRECTORY, cwd = process.cwd() } = {}) {
	const rows = []
	const unreadable = []
	let directories = []

	try {
		directories = fs.existsSync(reportRoot) ? fs.readdirSync(reportRoot, { withFileTypes: true }) : []
	} catch (error) {
		unreadable.push("reports/mutation: " + error.message)
	}

	for (const directory of directories) {
		if (!directory.isDirectory()) continue
		const reportFile = path.join(reportRoot, directory.name, "mutation.json")
		if (!fs.existsSync(reportFile)) continue
		let report
		try {
			report = JSON.parse(fs.readFileSync(reportFile, "utf8"))
		} catch (error) {
			unreadable.push(directory.name + ": " + error.message)
			continue
		}
		if (
			report === null ||
			typeof report !== "object" ||
			report.files === null ||
			typeof report.files !== "object"
		) {
			unreadable.push(directory.name + ": report has no files map")
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
			if (counts.mutants === 0) continue
			const relative = normalizeReportPath(filePath, report.projectRoot, cwd)
			if (relative === undefined) {
				unreadable.push(directory.name + ": rejected unsafe report path")
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
		for (const row of rows) {
			// Stryker counts a Timeout mutant as detected, so the mutation score numerator is
			// Killed + Timeout (the table's Killed column stays Killed-only).
			const score = (((row.killed + row.timeout) / row.mutants) * 100).toFixed(1)
			lines.push(
				"| " +
					BACKTICK +
					escapeMarkdownCell(row.file) +
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
		lines.push(
			"",
			"Close a surviving or uncovered mutant with a focused test that fails under the mutation; the artifact does not need to be downloaded to read this table.",
		)
	}

	if (unreadable.length > 0) lines.push("", "Unreadable report(s): " + unreadable.map(escapeMarkdownCell).join("; "))

	return { lines, rows, unreadable }
}

/**
 * Append through a crash-safe path: read the existing summary, write the combined content to a
 * temporary file in the same directory, then rename it over the target. A partial append would
 * leave the job summary truncated; the rename is atomic within one filesystem.
 */
function appendSummaryAtomically(outputFile, summary) {
	const existing = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : ""
	const directory = path.dirname(outputFile)
	const temporary = path.join(
		directory,
		"." + path.basename(outputFile) + "." + process.pid + "." + Date.now() + ".tmp",
	)
	fs.writeFileSync(temporary, existing + summary)
	try {
		fs.renameSync(temporary, outputFile)
	} catch (error) {
		try {
			fs.unlinkSync(temporary)
		} catch {
			// Best effort: the caller is already failing the write.
		}
		throw error
	}
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
		if (outputFile) appendSummaryAtomically(outputFile, summary)
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
