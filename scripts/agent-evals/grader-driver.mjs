// Acceptance-test driver. Runs the workspace test suite with the Node test
// runner and writes one result JSON file. Test failures are data, not exit
// codes: the driver exits 0 after writing any completed result. A nonzero exit
// or a missing result file means the grader itself failed, not the solution.
// The driver receives no credential and needs no network.
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const outPath = process.argv[2]
if (!outPath) {
	process.stderr.write("usage: grader-driver.mjs <result-json-path> [test-dir]\n")
	process.exit(2)
}
const testDir = process.argv[3] ?? "test"

const writeResult = (result) => {
	fs.mkdirSync(path.dirname(outPath), { recursive: true })
	fs.writeFileSync(outPath, JSON.stringify(result))
}

const TEST_EXTENSIONS = new Set([".js", ".mjs", ".cjs"])

const discoverTestFiles = (dir) => {
	const files = []
	const visit = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name)
			if (entry.isDirectory()) visit(full)
			else if (entry.isFile() && TEST_EXTENSIONS.has(path.extname(entry.name)) && entry.name.includes(".test."))
				files.push(full)
		}
	}
	visit(dir)
	return files.sort()
}

const readCounts = (tap) => {
	const read = (name) => {
		const match = tap.match(new RegExp(`^# ${name} (\\d+)\\s*$`, "m"))
		return match ? Number(match[1]) : undefined
	}
	return { passed: read("pass"), failed: read("fail"), cancelled: read("cancelled") }
}

const readFailureNames = (tap) => {
	const matches = [...tap.matchAll(/^(\s*)not ok \d+ - (.+)$/gm)].map((match) => ({
		indented: match[1].length > 0,
		name: match[2],
	}))
	// Prefer indented entries: they name the failing tests inside the files.
	// Top-level entries name the files and only appear when the whole file
	// failed.
	const specific = matches.filter((match) => match.indented)
	const chosen = specific.length > 0 ? specific : matches
	return chosen.slice(0, 50).map((match) => match.name)
}

// One child per test file. Failure names stay attributable to their file,
// which is how the grader separates hidden-test failures from visible-test
// failures.
const runOneFile = (file) =>
	new Promise((resolve) => {
		const child = spawn(process.execPath, ["--test", "--test-reporter", "tap", file], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
		})
		let tap = ""
		child.stdout.on("data", (chunk) => {
			tap += String(chunk)
		})
		child.stderr.on("data", (chunk) => {
			tap += String(chunk)
		})
		child.once("error", () => resolve({ ok: false, tap: "" }))
		child.once("close", () => resolve({ ok: true, tap }))
	})

try {
	const files = fs.existsSync(testDir) ? discoverTestFiles(testDir) : []
	if (files.length === 0) {
		writeResult({
			kind: "completed",
			passed: false,
			noTestsDiscovered: true,
			testFiles: [],
			passedCount: 0,
			failedCount: 0,
			failures: [],
			durationMs: 0,
		})
		process.exit(0)
	}
	const started = Date.now()
	let passedCount = 0
	let failedCount = 0
	let runnerBroke = false
	const failures = []
	for (const file of files) {
		const outcome = await runOneFile(file)
		if (!outcome.ok) {
			runnerBroke = true
			break
		}
		const counts = readCounts(outcome.tap)
		if (counts.passed === undefined || counts.failed === undefined) {
			// A file without a TAP summary means the runner never reported.
			runnerBroke = true
			break
		}
		passedCount += counts.passed
		failedCount += counts.failed
		if (counts.failed > 0 && failures.length < 50)
			for (const name of readFailureNames(outcome.tap)) failures.push({ name, file })
	}
	if (runnerBroke) {
		writeResult({ kind: "driver-error", message: "testRunnerUnavailable" })
		process.exit(0)
	}
	writeResult({
		kind: "completed",
		passed: failedCount === 0 && passedCount > 0,
		noTestsDiscovered: false,
		testFiles: files,
		passedCount,
		failedCount,
		failures,
		durationMs: Date.now() - started,
	})
	process.exit(0)
} catch (error) {
	// The driver itself crashed. Record it as a grader failure, never as a
	// solution failure.
	writeResult({
		kind: "driver-error",
		message: error instanceof Error ? error.name : "driver-error",
	})
	process.exit(0)
}
