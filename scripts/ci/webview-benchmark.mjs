import { spawnSync } from "node:child_process"
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export function validateOptions(workers, repetitions) {
	if (![1, 2, 4].includes(workers) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) {
		throw new Error("Workers must be 1, 2 or 4; repetitions must be an integer from 1 to 5")
	}
}

export function summarizeReport(report) {
	const inventory = report.files
		.map((file) => [file.file, file.tests.map((test) => test.name).sort()])
		.sort(([left], [right]) => left.localeCompare(right, "en"))
	const tests = report.files.flatMap((file) => file.tests)
	return {
		inventory,
		fileCount: report.files.length,
		testCount: tests.length,
		passed: tests.filter((test) => test.state === "passed").length,
		skipped: tests.filter((test) => test.state === "skipped" || test.state === "pending").length,
		failed: tests.filter((test) => test.state === "failed").length,
		failedFiles: report.files.filter((file) => !file.ok).length,
		unhandledErrors: report.errors.length,
		retries: tests.reduce((count, test) => count + (test.diagnostic?.retryCount ?? 0), 0),
	}
}

export function coveredLines(lcov) {
	let source
	const covered = new Set()
	for (const line of lcov.split(/\r?\n/)) {
		if (line.startsWith("SF:")) source = line.slice(3).replaceAll("\\", "/")
		if (line.startsWith("DA:")) {
			const [number, hits] = line.slice(3).split(",")
			if (
				!source ||
				!Number.isInteger(Number(number)) ||
				Number(number) < 1 ||
				!Number.isInteger(Number(hits)) ||
				Number(hits) < 0
			) {
				throw new Error("Invalid LCOV line record")
			}
			if (Number(hits) > 0) covered.add(`${source}:${number}`)
		}
		if (line === "end_of_record") source = undefined
	}
	return [...covered].sort()
}

export function compareRuns(runs, repetitions = 2) {
	const errors = []
	const inventory = JSON.stringify(runs[0]?.inventory)
	const sha = runs[0]?.sha
	const linuxCoverage = runs.find((run) => run.platform === "linux")?.coveredLines
	if (runs.length !== 6 * repetitions) errors.push(`Expected ${6 * repetitions} benchmark runs, got ${runs.length}`)
	for (const platform of ["linux", "win32"]) {
		for (const workers of [1, 2, 4]) {
			const group = runs.filter((run) => run.platform === platform && run.workers === workers)
			if (
				group.length !== repetitions ||
				new Set(group.map((run) => run.repetition)).size !== repetitions ||
				group.some(
					(run) => !Number.isInteger(run.repetition) || run.repetition < 1 || run.repetition > repetitions,
				)
			) {
				errors.push(`${platform}/${workers}: expected ${repetitions} distinct repetitions, got ${group.length}`)
			}
		}
	}
	for (const run of runs) {
		const label = `${run.platform}/${run.workers}/r${run.repetition}`
		if (
			run.exitCode !== 0 ||
			run.failed ||
			run.failedFiles ||
			run.unhandledErrors ||
			run.retries ||
			!run.testCount ||
			run.passed + run.skipped !== run.testCount
		) {
			errors.push(`${label}: incomplete, failing or retried tests`)
		}
		if (run.sha !== sha || JSON.stringify(run.inventory) !== inventory)
			errors.push(`${label}: source/test inventory differs`)
		if (run.coverage !== (run.platform === "linux")) errors.push(`${label}: coverage mode differs from the CI lane`)
		if (
			run.platform === "linux" &&
			(!run.coveredLines?.length || JSON.stringify(run.coveredLines) !== JSON.stringify(linuxCoverage))
		) {
			errors.push(`${label}: covered-line identities differ or coverage is missing`)
		}
	}
	return errors
}

function findMetadata(directory) {
	if (!existsSync(directory)) return []
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const fullPath = path.join(directory, entry.name)
		return entry.isDirectory() ? findMetadata(fullPath) : entry.name === "metadata.json" ? [fullPath] : []
	})
}

function publishSummary(markdown) {
	console.log(markdown)
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n")
}

function summarize(output, repetitions) {
	const runs = findMetadata(output).map((filename) => {
		const metadata = JSON.parse(readFileSync(filename, "utf8"))
		if (metadata.coverage) {
			const coverageFile = path.join(path.dirname(filename), "coverage/lcov.info")
			metadata.coveredLines = existsSync(coverageFile) ? coveredLines(readFileSync(coverageFile, "utf8")) : []
		}
		return metadata
	})
	const errors = compareRuns(runs, repetitions)
	mkdirSync(output, { recursive: true })
	writeFileSync(path.join(output, "comparison.json"), JSON.stringify({ errors, runs }, null, 2) + "\n")
	const table = [
		"## Webview benchmark",
		"",
		"Elapsed time measures the Vitest process, including startup and coverage reporting; installation and prerequisite builds are separate steps.",
		"",
		"| Platform | Workers | Repetition | Coverage | Seconds | Files | Tests | Exit |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
		...runs.map(
			(run) =>
				`| ${run.platform} | ${run.workers} | ${run.repetition} | ${run.coverage} | ${run.wallSeconds.toFixed(2)} | ${run.fileCount} | ${run.testCount} | ${run.exitCode} |`,
		),
		"",
		...errors.map((error) => `- ${error}`),
	]
	publishSummary(table.join("\n"))
	if (errors.length) process.exitCode = 1
}

function measure(workers, repetitions, output) {
	validateOptions(workers, repetitions)
	const webviewRoot = path.join(repositoryRoot, "webview-ui")
	const require = createRequire(path.join(webviewRoot, "package.json"))
	const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs")
	const coverage = process.env.WEBVIEW_BENCHMARK_COVERAGE === "true"
	for (let repetition = 1; repetition <= repetitions; repetition++) {
		const runDirectory = path.join(output, `run-${repetition}`)
		mkdirSync(runDirectory, { recursive: true })
		if (existsSync(path.join(runDirectory, "metadata.json")))
			throw new Error(`Refusing to overwrite ${runDirectory}`)
		const stdout = openSync(path.join(runDirectory, "stdout.log"), "w")
		const stderr = openSync(path.join(runDirectory, "stderr.log"), "w")
		const args = [
			vitest,
			"run",
			"--config",
			"vitest.benchmark.config.ts",
			`--maxWorkers=${workers}`,
			"--pool=forks",
			"--isolate",
			"--logHeapUsage",
			"--reporter=default",
			`--reporter=${path.join(repositoryRoot, "scripts/ci/webview-benchmark-reporter.mjs")}`,
		]
		if (coverage) args.push("--coverage")
		console.log(`::group::${process.platform}: ${workers} workers, repetition ${repetition}, coverage=${coverage}`)
		const startedAt = new Date().toISOString()
		const start = performance.now()
		let result
		try {
			result = spawnSync(process.execPath, args, {
				cwd: webviewRoot,
				env: {
					...process.env,
					CI: "true",
					TZ: "UTC",
					WEBVIEW_BENCHMARK_RUN_DIR: runDirectory,
					WEBVIEW_BENCHMARK_REPORT: path.join(runDirectory, "modules.json"),
				},
				stdio: ["ignore", stdout, stderr],
				timeout: 15 * 60 * 1000,
			})
		} finally {
			closeSync(stdout)
			closeSync(stderr)
		}
		const wallSeconds = (performance.now() - start) / 1000
		const reportFile = path.join(runDirectory, "modules.json")
		const summary = existsSync(reportFile)
			? summarizeReport(JSON.parse(readFileSync(reportFile, "utf8")))
			: { fileCount: 0, testCount: 0, inventory: [] }
		const exitCode = result.status ?? 1
		const metadata = {
			...summary,
			workers,
			repetition,
			coverage,
			exitCode,
			wallSeconds,
			startedAt,
			completedAt: new Date().toISOString(),
			sha:
				process.env.GITHUB_SHA ??
				spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim(),
			platform: process.platform,
			arch: process.arch,
			node: process.version,
			vitest: require("vitest/package.json").version,
			availableParallelism: os.availableParallelism(),
			cpuModel: os.cpus()[0]?.model,
			totalMemoryBytes: os.totalmem(),
			imageOS: process.env.ImageOS,
			imageVersion: process.env.ImageVersion,
			runId: process.env.GITHUB_RUN_ID,
			runAttempt: process.env.GITHUB_RUN_ATTEMPT,
			error: result.error?.message,
			signal: result.signal,
		}
		writeFileSync(path.join(runDirectory, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n")
		console.log(readFileSync(path.join(runDirectory, "stdout.log"), "utf8"))
		console.error(readFileSync(path.join(runDirectory, "stderr.log"), "utf8"))
		console.log("::endgroup::")
		publishSummary(
			`Repetition ${repetition}: ${workers} workers, ${wallSeconds.toFixed(2)}s, ${summary.testCount} tests, exit ${exitCode}.`,
		)
		if (
			exitCode !== 0 ||
			!summary.testCount ||
			summary.failed ||
			summary.failedFiles ||
			summary.unhandledErrors ||
			summary.retries
		)
			process.exitCode = 1
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({
		options: {
			workers: { type: "string" },
			repetitions: { type: "string", default: "2" },
			output: { type: "string", default: "benchmark-results" },
			summarize: { type: "boolean", default: false },
		},
	})
	const output = path.resolve(values.output)
	const repetitions = Number(values.repetitions)
	if (values.summarize) {
		validateOptions(1, repetitions)
		summarize(output, repetitions)
	} else {
		measure(Number(values.workers), repetitions, output)
	}
}
