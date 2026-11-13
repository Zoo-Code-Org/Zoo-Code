// Acceptance-test driver. Runs the workspace test suite with the Node test
// runner and writes one result JSON file. Test failures are data, not exit
// codes: the driver exits 0 after writing any completed result. A nonzero exit
// or a missing result file means the grader itself failed, not the solution.
// The driver receives no credential and needs no network.
import { summarizeTestEvents } from "./grader-events.mjs"
import process from "node:process"
import { run } from "node:test"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const outPath = process.argv[2]
if (!outPath) {
	process.stderr.write("usage: grader-driver.mjs <result-json-path> [test-dir]\n")
	process.exit(2)
}
const testDir = process.argv[3] ?? "test"
// Supplied by the trusted runtime, never loaded from the agent workspace.
const trustedTests = new Map(
	JSON.parse(process.argv[4] ?? "[]").map(({ path: file, sha256 }) => [path.resolve(file), sha256]),
)

// The result file is the host's only view of the grading outcome, so its
// publication is atomic: the content lands in a unique same-directory temp
// file and is renamed into place. A reader never observes a partial write,
// and a failed write or rename removes the temp file before the error
// propagates.
const writeResult = (result) => {
	fs.mkdirSync(path.dirname(outPath), { recursive: true })
	const temp = path.join(
		path.dirname(outPath),
		`.${path.basename(outPath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
	)
	try {
		fs.writeFileSync(temp, JSON.stringify(result))
		fs.renameSync(temp, outPath)
	} catch (error) {
		try {
			fs.rmSync(temp, { force: true })
		} catch {
			/* The temp file is already gone. */
		}
		throw error
	}
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

// Consume the runner's structured events in this trusted process. stdout and
// stderr are diagnostic events only; neither can supply verdict counts. The
// child permission policy also prevents solution code writing the result file
// or launching another process to do so.
const runOneFile = async (file) => {
	const source = fs.readFileSync(file)
	const trusted = trustedTests.get(path.resolve(file)) === createHash("sha256").update(source).digest("hex")
	// Only frozen, verified acceptance declarations define required test names.
	// Visible source may contain comments, strings or dynamic declarations.
	const expected = trusted
		? [...source.toString("utf8").matchAll(/\btest\(["']([^"']+)["'],/g)].map((match) => match[1])
		: []
	// Initialize the runner even for an empty visible file. A natural finish
	// emits a per-file summary; process.exit before completion does not.
	const stream = run({
		files: [path.resolve(file)],
		execArgv: [
			process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission",
			`--allow-fs-read=${process.cwd()}`,
			...(trusted ? ["--allow-child-process"] : []),
			...(!trusted
				? ["--import", 'data:text/javascript,import { after } from "node:test"; after(() => {})']
				: []),
		],
	})
	return summarizeTestEvents(stream, expected, path.resolve(file), trusted).then((outcome) => ({
		...outcome,
		failures: outcome.failures.map((failure) => ({ ...failure, file })),
	}))
}

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
			cancelledCount: 0,
			failures: [],
			durationMs: 0,
		})
		process.exit(0)
	}
	const started = Date.now()
	let passedCount = 0
	let failedCount = 0
	// Cancelled tests never ran. A passing verdict requires zero of them, so a
	// solution cannot pass while a hidden test stayed pending.
	let cancelledCount = 0
	let runnerBroke = false
	const failures = []
	for (const file of files) {
		const outcome = await runOneFile(file)
		if (!outcome.complete) {
			runnerBroke = true
			break
		}
		passedCount += outcome.passed
		failedCount += outcome.failed
		cancelledCount += outcome.cancelled
		failures.push(...outcome.failures.slice(0, 50 - failures.length))
	}
	if (runnerBroke) {
		writeResult({ kind: "driver-error", message: "testRunnerUnavailable" })
		process.exit(0)
	}
	writeResult({
		kind: "completed",
		passed: failedCount === 0 && cancelledCount === 0 && passedCount > 0,
		noTestsDiscovered: false,
		testFiles: files,
		passedCount,
		failedCount,
		cancelledCount,
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
