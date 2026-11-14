import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { normalizeReportPath, summarizeMutationReports, writeMutationSummary } from "./mutation-summary.mjs"

const SCRIPT_PATH = fileURLToPath(new URL("./mutation-summary.mjs", import.meta.url))
const BACKTICK = "`"

function makeRoot(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-summary-"))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	return root
}

function writeReport(root, packageName, report) {
	const directory = path.join(root, packageName)
	fs.mkdirSync(directory, { recursive: true })
	fs.writeFileSync(path.join(directory, "mutation.json"), JSON.stringify(report), "utf8")
}

function mutants(...statuses) {
	return statuses.map((status) => ({ status }))
}

test("counts valid statuses including Timeout and skips unknown ones", (t) => {
	const root = makeRoot(t)
	writeReport(root, "pkg", {
		files: {
			"src/a.ts": { mutants: mutants("Killed", "Survived", "Survived", "NoCoverage", "Timeout", "Exploded") },
		},
	})
	const { lines: summaryLines, rows } = summarizeMutationReports({ reportRoot: root, cwd: root })
	assert.equal(rows.length, 1)
	assert.deepEqual(rows[0], {
		file: "src/a.ts",
		mutants: 5,
		killed: 1,
		survived: 2,
		noCoverage: 1,
		timeout: 1,
	})
	// The whole row, with distinct Survived and NoCoverage counts, so a swapped column pair
	// cannot pass: (1 killed + 1 timeout) / 5 mutants = 40.0%.
	assert.ok(summaryLines.join("\n").includes("| " + BACKTICK + "src/a.ts" + BACKTICK + " | 5 | 1 | 2 | 1 | 40.0% |"))
})

test("sorts by Survived + NoCoverage, worst first, then by path", (t) => {
	const root = makeRoot(t)
	writeReport(root, "pkg", {
		files: {
			"src/b.ts": { mutants: mutants("Killed", "Survived") },
			"src/a.ts": { mutants: mutants("Killed", "NoCoverage") },
			"src/c.ts": { mutants: mutants("Killed") },
			"src/d.ts": { mutants: mutants("Killed", "Survived") },
		},
	})
	const { rows } = summarizeMutationReports({ reportRoot: root, cwd: root })
	assert.deepEqual(
		rows.map((row) => row.file),
		["src/a.ts", "src/b.ts", "src/d.ts", "src/c.ts"],
	)
})

test("renders at most maxRows rows and counts the rest toward the artifact", (t) => {
	const root = makeRoot(t)
	const files = {}
	for (let index = 0; index < 45; index += 1) {
		const name = "src/" + String(index).padStart(2, "0") + ".ts"
		files[name] = { mutants: mutants("Killed", "Survived") }
	}
	writeReport(root, "pkg", { files })
	const { lines: summaryLines, rows } = summarizeMutationReports({ reportRoot: root, cwd: root, maxRows: 3 })
	assert.equal(rows.length, 45)
	const text = summaryLines.join("\n")
	const renderedRows = text.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
	// Header row plus the three worst files only.
	assert.equal(renderedRows.length, 4)
	assert.ok(
		text.includes(
			"and 42 more files; see the " + BACKTICK + "changed-code-mutation-report" + BACKTICK + " artifact.",
		),
	)
})

test("reports an empty run when no reports exist", (t) => {
	const root = makeRoot(t)
	const { lines: summaryLines, rows } = summarizeMutationReports({
		reportRoot: path.join(root, "missing"),
		cwd: root,
	})
	assert.equal(rows.length, 0)
	assert.match(summaryLines.join("\n"), /No Stryker JSON report was produced/)
})

test("keeps processing when one report is malformed and reports it", (t) => {
	const root = makeRoot(t)
	fs.mkdirSync(path.join(root, "broken"), { recursive: true })
	fs.writeFileSync(path.join(root, "broken", "mutation.json"), "{not json", "utf8")
	writeReport(root, "good", { files: { "src/ok.ts": { mutants: mutants("Killed") } } })
	const { rows, unreadable } = summarizeMutationReports({ reportRoot: root, cwd: root })
	assert.equal(rows.length, 1)
	assert.equal(unreadable.length, 1)
	// Parser messages can quote report content: only the fixed diagnostic is rendered.
	assert.equal(unreadable[0], "broken: invalid JSON")
})

test("rejects reports whose files map is missing or not an object", (t) => {
	const root = makeRoot(t)
	writeReport(root, "nofiles", { mutants: [] })
	writeReport(root, "nullfiles", { files: null })
	const { rows, unreadable } = summarizeMutationReports({ reportRoot: root, cwd: root })
	assert.equal(rows.length, 0)
	assert.equal(unreadable.filter((entry) => /no files map/.test(entry)).length, 2)
})

test("rejects report paths that could break the table or escape the repo", (t) => {
	const root = makeRoot(t)
	const files = {
		"src/ok.ts": { mutants: mutants("Killed") },
		// Characters that would break out of a Markdown table cell or link.
		"injected|path": { mutants: mutants("Killed") },
		"[link](path)": { mutants: mutants("Killed") },
		"with space.ts": { mutants: mutants("Killed") },
		// Paths that leave the working directory, in either platform separator.
		"../outside.ts": { mutants: mutants("Killed") },
		"..\\outside.ts": { mutants: mutants("Killed") },
		// A leading dot-dot is a file name, not a parent-directory hop.
		"..weird.ts": { mutants: mutants("Killed") },
		"..foo.ts": { mutants: mutants("Killed") },
	}
	files["injected" + BACKTICK + "path"] = { mutants: mutants("Killed") }
	files["C:/abs/path.ts"] = { mutants: mutants("Killed") }
	writeReport(root, "pkg", { files })
	const { rows, unreadable } = summarizeMutationReports({ reportRoot: root, cwd: root })
	assert.deepEqual(rows.map((row) => row.file).sort(), ["..foo.ts", "..weird.ts", "src/ok.ts"])
	// pipe, bracket/link, space, both outside paths, backtick key and the absolute key.
	assert.equal(unreadable.filter((entry) => /rejected unsafe report path/.test(entry)).length, 7)
})

test("normalizes paths against the report projectRoot, including backslash separators", (t) => {
	const root = makeRoot(t)
	const projectRoot = path.join(root, "pkg")
	assert.equal(normalizeReportPath(path.join(projectRoot, "src", "x.ts"), projectRoot, root), "pkg/src/x.ts")
	assert.equal(normalizeReportPath("src/x.ts", projectRoot, root), "pkg/src/x.ts")
	// Stryker can emit platform separators; they normalize to one repo-relative path.
	assert.equal(normalizeReportPath("src\\sub\\x.ts", projectRoot, root), "pkg/src/sub/x.ts")
	// Two levels up leaves the working directory and is rejected; one level up resolves to a
	// path that is still inside it, so it is a repo path rather than an escape.
	assert.equal(normalizeReportPath("../../escape.ts", projectRoot, root), undefined)
	assert.equal(normalizeReportPath("../sibling.ts", projectRoot, root), "sibling.ts")
	assert.equal(normalizeReportPath("..\\..\\escape.ts", projectRoot, root), undefined)
	assert.equal(normalizeReportPath("..", projectRoot, root), undefined)
	// The mutation-diff runner is POSIX, where a doubled backslash is part of one file name
	// inside the package, so path.relative renders it as a traversal-looking string - the
	// shape that slipped past a startsWith("../") check in CI. Pinned with
	// path.posix so it is checked on any runner OS, not only the one that shipped the bug.
	const posixRendered = path.posix
		.relative("/w", path.posix.resolve("/w/pkg", "..\\..\\escape.ts"))
		.replaceAll("\\", "/")
	assert.equal(posixRendered, "pkg/../../escape.ts")
	// ...and the exact rule that now rejects it: a ".." component in the rendered
	// string. The old startsWith("../") check let this through on a POSIX runner.
	assert.ok(!posixRendered.startsWith("../"))
	assert.ok(posixRendered.split("/").includes(".."))
	assert.equal(normalizeReportPath("..\\..\\escape.ts", "/w/pkg", "/w"), undefined)
})

test("rejects a non-string projectRoot instead of resolving against it", (t) => {
	const root = makeRoot(t)
	writeReport(root, "pkg", { files: { "src/a.ts": { mutants: mutants("Killed") } } })
	const report = JSON.parse(fs.readFileSync(path.join(root, "pkg", "mutation.json"), "utf8"))
	report.projectRoot = 42
	fs.writeFileSync(path.join(root, "pkg", "mutation.json"), JSON.stringify(report), "utf8")

	const { rows, unreadable } = summarizeMutationReports({ reportRoot: root, cwd: root })

	assert.equal(rows.length, 0)
	assert.equal(unreadable.filter((entry) => /rejected unsafe report path/.test(entry)).length, 1)
})

test("writeMutationSummary appends to the configured file", (t) => {
	const root = makeRoot(t)
	const reportRoot = path.join(root, "reports", "mutation")
	writeReport(reportRoot, "pkg", { files: { "src/a.ts": { mutants: mutants("Killed") } } })
	const outputFile = path.join(root, "summary.md")
	fs.writeFileSync(outputFile, "existing summary\n", "utf8")

	const summary = writeMutationSummary({ reportRoot, cwd: root, outputFile })

	const content = fs.readFileSync(outputFile, "utf8")
	assert.ok(content.startsWith("existing summary\n"))
	assert.ok(content.endsWith(summary))
	assert.match(content, /Per-file mutation results/)
})

test("writeMutationSummary writes to stdout when no output file is configured", (t) => {
	const root = makeRoot(t)
	const reportRoot = path.join(root, "reports", "mutation")
	writeReport(reportRoot, "pkg", { files: { "src/a.ts": { mutants: mutants("Killed") } } })
	const written = []
	const originalWrite = process.stdout.write.bind(process.stdout)
	process.stdout.write = (chunk) => {
		written.push(String(chunk))
		return true
	}
	t.after(() => {
		process.stdout.write = originalWrite
	})

	// An empty output file forces the stdout branch even when GITHUB_STEP_SUMMARY is set in CI.
	writeMutationSummary({ reportRoot, cwd: root, outputFile: "" })

	assert.match(written.join(""), /Per-file mutation results/)
})

test("writeMutationSummary warns instead of throwing when the output cannot be written", (t) => {
	const root = makeRoot(t)
	const reportRoot = path.join(root, "reports", "mutation")
	writeReport(reportRoot, "pkg", { files: { "src/a.ts": { mutants: mutants("Killed") } } })
	const logs = []
	const originalLog = console.log
	console.log = (message) => {
		logs.push(String(message))
	}
	t.after(() => {
		console.log = originalLog
	})

	// The directory does not exist, so the append fails and has to be reported.
	assert.doesNotThrow(() =>
		writeMutationSummary({ reportRoot, cwd: root, outputFile: path.join(root, "missing", "summary.md") }),
	)
	assert.match(logs.join("\n"), /Could not write the per-file mutation summary/)
})

test("running the script as a step writes GITHUB_STEP_SUMMARY", (t) => {
	const root = makeRoot(t)
	writeReport(path.join(root, "reports", "mutation"), "pkg", {
		files: { "src/a.ts": { mutants: mutants("Killed", "Survived") } },
	})
	const outputFile = path.join(root, "summary.md")
	fs.writeFileSync(outputFile, "### Gate summary\n", "utf8")

	const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
		cwd: root,
		env: { ...process.env, GITHUB_STEP_SUMMARY: outputFile },
		encoding: "utf8",
	})

	const content = fs.readFileSync(outputFile, "utf8")
	assert.match(content, /Per-file mutation results/)
	assert.match(content, /\| `src\/a\.ts` \| 2 \| 1 \| 1 \| 0 \| 50\.0% \|/)
	// The summary is the deliverable; the step must not duplicate it on stdout.
	assert.equal(stdout.trim(), "")
})

test("running the script with an unwritable GITHUB_STEP_SUMMARY still exits 0", (t) => {
	const root = makeRoot(t)
	writeReport(path.join(root, "reports", "mutation"), "pkg", {
		files: { "src/a.ts": { mutants: mutants("Killed") } },
	})
	const unwritable = path.join(root, "missing-dir", "summary.md")

	// execFileSync throws when the child exits non-zero, so a throw here is the failure.
	const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
		cwd: root,
		env: { ...process.env, GITHUB_STEP_SUMMARY: unwritable },
		encoding: "utf8",
	})

	assert.match(stdout, /::warning title=Mutation test advisory::Could not write the per-file mutation summary/)
	assert.equal(fs.existsSync(unwritable), false)
})
