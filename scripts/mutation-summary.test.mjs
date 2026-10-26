import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
	escapeMarkdownCell,
	normalizeReportPath,
	summarizeMutationReports,
	writeMutationSummary,
} from "./mutation-summary.mjs"

const BACKTICK = String.fromCharCode(96)

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
		files: { "src/a.ts": { mutants: mutants("Killed", "Survived", "NoCoverage", "Timeout", "Exploded") } },
	})
	const { lines: summaryLines, rows } = summarizeMutationReports({ reportRoot: root, cwd: root })
	assert.equal(rows.length, 1)
	assert.deepEqual(
		{
			mutants: rows[0].mutants,
			killed: rows[0].killed,
			survived: rows[0].survived,
			noCoverage: rows[0].noCoverage,
		},
		{ mutants: 4, killed: 1, survived: 1, noCoverage: 1 },
	)
	const text = summaryLines.join("\n")
	assert.match(text, /src\/a\.ts/)
	// Stryker counts the Timeout mutant as detected: (1 killed + 1 timeout) / 4 mutants = 50%.
	assert.match(text, /50\.0%/)
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

test("rejects unsafe report paths instead of rendering them", (t) => {
	const root = makeRoot(t)
	writeReport(root, "pkg", {
		files: {
			"src/ok.ts": { mutants: mutants("Killed") },
			"injected|path": { mutants: mutants("Killed") },
			"../outside.ts": { mutants: mutants("Killed") },
		},
	})
	const { rows, unreadable } = summarizeMutationReports({ reportRoot: root, cwd: root })
	assert.deepEqual(
		rows.map((row) => row.file),
		["src/ok.ts"],
	)
	assert.equal(unreadable.filter((entry) => /rejected unsafe report path/.test(entry)).length, 2)
})

test("escapes Markdown metacharacters in rendered cells", (t) => {
	assert.equal(escapeMarkdownCell("a|b"), "a\\|b")
	assert.equal(escapeMarkdownCell("a" + BACKTICK + "b"), "a\\" + BACKTICK + "b")
	assert.equal(escapeMarkdownCell("[x](y)"), "\\[x\\]\\(y\\)")
	assert.equal(escapeMarkdownCell("a\r\nb"), "a\\r\\nb")
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

test("normalizes a project-root-relative report path against the working directory", (t) => {
	const root = makeRoot(t)
	const projectRoot = path.join(root, "pkg")
	assert.equal(normalizeReportPath(path.join(projectRoot, "src", "x.ts"), projectRoot, root), "pkg/src/x.ts")
	assert.equal(normalizeReportPath("src/x.ts", projectRoot, root), "pkg/src/x.ts")
	assert.equal(normalizeReportPath("../../escape.ts", projectRoot, root), undefined)
})

test("writeMutationSummary appends to the configured file atomically", (t) => {
	const root = makeRoot(t)
	const reportRoot = path.join(root, "reports", "mutation")
	writeReport(reportRoot, "pkg", { files: { "src/a.ts": { mutants: mutants("Killed") } } })
	const outputFile = path.join(root, "summary.md")
	fs.writeFileSync(outputFile, "existing summary\n", "utf8")

	const summary = writeMutationSummary({ reportRoot, cwd: root, outputFile })

	const content = fs.readFileSync(outputFile, "utf8")
	assert.match(content, /existing summary/)
	assert.match(content, /Per-file mutation results/)
	assert.ok(content.endsWith(summary))
	// The atomic append leaves no temporary sibling behind.
	assert.deepEqual(
		fs.readdirSync(root).filter((entry) => entry.includes(".tmp")),
		[],
	)
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

	// The directory does not exist, so the atomic write must fail and be reported.
	assert.doesNotThrow(() =>
		writeMutationSummary({ reportRoot, cwd: root, outputFile: path.join(root, "missing", "summary.md") }),
	)
	assert.match(logs.join("\n"), /Could not write the per-file mutation summary/)
})

test("writeMutationSummary removes a stale summary temp sibling", (t) => {
	const root = makeRoot(t)
	const reportRoot = path.join(root, "reports", "mutation")
	writeReport(reportRoot, "pkg", { files: { "src/a.ts": { mutants: mutants("Killed") } } })
	const outputFile = path.join(root, "summary.md")
	fs.writeFileSync(outputFile, "existing summary\n", "utf8")
	const stale = path.join(root, ".summary.md.other.123.tmp")
	fs.writeFileSync(stale, "stale", "utf8")

	writeMutationSummary({ reportRoot, cwd: root, outputFile })

	assert.equal(fs.existsSync(stale), false)
	assert.deepEqual(
		fs.readdirSync(root).filter((entry) => entry.includes(".tmp")),
		[],
	)
})

test("writeMutationSummary cleans its temp file when the rename fails", (t) => {
	const root = makeRoot(t)
	const reportRoot = path.join(root, "reports", "mutation")
	writeReport(reportRoot, "pkg", { files: { "src/a.ts": { mutants: mutants("Killed") } } })
	// A regular existing file is the target, so the initial read succeeds and the write really
	// reaches the rename step; the rename itself then fails.
	const outputFile = path.join(root, "summary.md")
	fs.writeFileSync(outputFile, "existing summary\n", "utf8")
	const logs = []
	const originalLog = console.log
	const originalRename = fs.renameSync
	let renameAttempts = 0
	console.log = (message) => {
		logs.push(String(message))
	}
	fs.renameSync = () => {
		renameAttempts += 1
		throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" })
	}
	t.after(() => {
		console.log = originalLog
		fs.renameSync = originalRename
	})

	assert.doesNotThrow(() => writeMutationSummary({ reportRoot, cwd: root, outputFile }))

	// The write got past the read and the temp write, and the temp file was cleaned up.
	assert.equal(renameAttempts, 1)
	assert.match(logs.join("\n"), /Could not write the per-file mutation summary: EIO/)
	assert.deepEqual(
		fs.readdirSync(root).filter((entry) => entry.includes(".tmp")),
		[],
	)
	// The failed rename left the existing summary untouched.
	assert.equal(fs.readFileSync(outputFile, "utf8"), "existing summary\n")
})
