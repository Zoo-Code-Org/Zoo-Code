import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { escapeMarkdownCell, normalizeReportPath, summarizeMutationReports } from "./mutation-summary.mjs"

const BACKTICK = String.fromCharCode(96)

function makeRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "mutation-summary-"))
}

function writeReport(root, packageName, report) {
	const directory = path.join(root, packageName)
	fs.mkdirSync(directory, { recursive: true })
	fs.writeFileSync(path.join(directory, "mutation.json"), JSON.stringify(report), "utf8")
}

function mutants(...statuses) {
	return statuses.map((status) => ({ status }))
}

test("counts valid statuses including Timeout and skips unknown ones", () => {
	const root = makeRoot()
	writeReport(root, "pkg", { files: { "src/a.ts": { mutants: mutants("Killed", "Survived", "NoCoverage", "Timeout", "Exploded") } } })
	const { lines: summaryLines, rows } = summarizeMutationReports({ reportRoot: root, cwd: root })
	assert.equal(rows.length, 1)
	assert.deepEqual(
		{ mutants: rows[0].mutants, killed: rows[0].killed, survived: rows[0].survived, noCoverage: rows[0].noCoverage },
		{ mutants: 4, killed: 1, survived: 1, noCoverage: 1 },
	)
	const text = summaryLines.join("\n")
	assert.match(text, /src\/a\.ts/)
	assert.match(text, /25\.0%/)
})

test("sorts by Survived + NoCoverage, worst first, then by path", () => {
	const root = makeRoot()
	writeReport(root, "pkg", {
		files: {
			"src/b.ts": { mutants: mutants("Killed", "Survived") },
			"src/a.ts": { mutants: mutants("Killed", "NoCoverage") },
			"src/c.ts": { mutants: mutants("Killed") },
			"src/d.ts": { mutants: mutants("Killed", "Survived") },
		},
	})
	const { rows } = summarizeMutationReports({ reportRoot: root, cwd: root })
	assert.deepEqual(rows.map((row) => row.file), ["src/a.ts", "src/b.ts", "src/d.ts", "src/c.ts"])
})

test("reports an empty run when no reports exist", () => {
	const root = makeRoot()
	const { lines: summaryLines, rows } = summarizeMutationReports({ reportRoot: path.join(root, "missing"), cwd: root })
	assert.equal(rows.length, 0)
	assert.match(summaryLines.join("\n"), /No Stryker JSON report was produced/)
})

test("keeps processing when one report is malformed and reports it", () => {
	const root = makeRoot()
	fs.mkdirSync(path.join(root, "broken"), { recursive: true })
	fs.writeFileSync(path.join(root, "broken", "mutation.json"), "{not json", "utf8")
	writeReport(root, "good", { files: { "src/ok.ts": { mutants: mutants("Killed") } } })
	const { rows, unreadable } = summarizeMutationReports({ reportRoot: root, cwd: root })
	assert.equal(rows.length, 1)
	assert.equal(unreadable.length, 1)
	assert.match(unreadable[0], /broken/)
})

test("rejects reports whose files map is missing or not an object", () => {
	const root = makeRoot()
	writeReport(root, "nofiles", { mutants: [] })
	writeReport(root, "nullfiles", { files: null })
	const { rows, unreadable } = summarizeMutationReports({ reportRoot: root, cwd: root })
	assert.equal(rows.length, 0)
	assert.equal(unreadable.filter((entry) => /no files map/.test(entry)).length, 2)
})

test("rejects unsafe report paths instead of rendering them", () => {
	const root = makeRoot()
	writeReport(root, "pkg", {
		files: {
			"src/ok.ts": { mutants: mutants("Killed") },
			"injected|path": { mutants: mutants("Killed") },
			"../outside.ts": { mutants: mutants("Killed") },
		},
	})
	const { rows, unreadable } = summarizeMutationReports({ reportRoot: root, cwd: root })
	assert.deepEqual(rows.map((row) => row.file), ["src/ok.ts"])
	assert.equal(unreadable.filter((entry) => /rejected unsafe report path/.test(entry)).length, 2)
})

test("escapes Markdown metacharacters in rendered cells", () => {
	assert.equal(escapeMarkdownCell("a|b"), "a\\|b")
	assert.equal(escapeMarkdownCell("a" + BACKTICK + "b"), "a\\" + BACKTICK + "b")
	assert.equal(escapeMarkdownCell("a\r\nb"), "a\\r\\nb")
})

test("normalizes a project-root-relative report path against the working directory", () => {
	const root = makeRoot()
	const projectRoot = path.join(root, "pkg")
	assert.equal(normalizeReportPath(path.join(projectRoot, "src", "x.ts"), projectRoot, root), "pkg/src/x.ts")
	assert.equal(normalizeReportPath("src/x.ts", projectRoot, root), "pkg/src/x.ts")
	assert.equal(normalizeReportPath("../../escape.ts", projectRoot, root), undefined)
})
