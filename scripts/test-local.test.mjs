import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import vm from "node:vm"
import ts from "typescript"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runner = path.join(root, "scripts/test-local.mjs")

// Patch only the child process. The real runner still parses arguments and controls both calls.
function runRunner(args = [], statuses = [0, 0], options = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-runner-test-"))
	try {
		const log = path.join(directory, "calls.jsonl")
		const preload = path.join(directory, "process-double.mjs")
		fs.writeFileSync(
			preload,
			`import childProcess from "node:child_process";
			import { appendFileSync } from "node:fs";
			import { syncBuiltinESMExports } from "node:module";
			Object.defineProperty(process, "platform", { value: process.env.LOCAL_RUNNER_PLATFORM });
			let index = 0;
			const statuses = JSON.parse(process.env.LOCAL_RUNNER_STATUSES);
			const errors = JSON.parse(process.env.LOCAL_RUNNER_ERRORS);
			const signals = JSON.parse(process.env.LOCAL_RUNNER_SIGNALS);
			childProcess.spawnSync = (command, args, options) => {
				appendFileSync(process.env.LOCAL_RUNNER_LOG, JSON.stringify({
					command, args, workers: options.env.VITEST_MAX_WORKERS, shell: Boolean(options.shell)
				}) + "\\n");
				const current = index++;
				return { status: statuses[current], signal: signals[current], error: errors[current] ? new Error(errors[current]) : undefined };
			};
			syncBuiltinESMExports();`,
		)
		const env = {
			...process.env,
			LOCAL_RUNNER_LOG: log,
			LOCAL_RUNNER_STATUSES: JSON.stringify(statuses),
			LOCAL_RUNNER_PLATFORM: options.platform ?? "linux",
			LOCAL_RUNNER_ERRORS: JSON.stringify(options.errors ?? [options.error ?? null]),
			LOCAL_RUNNER_SIGNALS: JSON.stringify(options.signals ?? []),
		}
		if (options.launcher === null) delete env.npm_execpath
		else if (options.launcher) env.npm_execpath = options.launcher
		delete env.VITEST_MAX_WORKERS
		if (options.inheritedWorkers !== undefined) env.VITEST_MAX_WORKERS = options.inheritedWorkers
		const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, runner, ...args], {
			env,
			encoding: "utf8",
		})
		assert.ifError(result.error)
		const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : []
		return { status: result.status, calls, stderr: result.stderr, stdout: result.stdout }
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
}

describe("local test runner contract", () => {
	for (const { name, args, workers, tasks } of [
		{ name: "defaults", args: [], workers: "4", tasks: "2" },
		{
			name: "equals overrides",
			args: ["--", "--vitest-workers=2", "--turbo-concurrency=1"],
			workers: "2",
			tasks: "1",
		},
		{
			name: "space overrides",
			args: ["--vitest-workers", "1", "--turbo-concurrency", "1"],
			workers: "1",
			tasks: "1",
		},
		{ name: "workers only", args: ["--vitest-workers=1"], workers: "1", tasks: "2" },
		{ name: "tasks only", args: ["--turbo-concurrency=1"], workers: "4", tasks: "1" },
		{ name: "missing values", args: ["--vitest-workers", "--turbo-concurrency"], workers: "4", tasks: "2" },
		{
			name: "invalid limits",
			args: ["--vitest-workers=0", "--turbo-concurrency=invalid"],
			workers: "4",
			tasks: "2",
		},
	]) {
		it(`bundles first and forwards ${name}`, () => {
			const result = runRunner([...args, "--force", "--filter=zoo-code"])
			assert.equal(result.status, 0, result.stderr)
			assert.equal(result.calls.length, 2)
			const [bundle, tests] = result.calls
			assert.equal(bundle.command, "pnpm")
			assert.deepEqual(bundle.args.slice(0, 4), ["exec", "turbo", "run", "bundle"])
			assert.equal(bundle.workers, undefined)
			assert.deepEqual(bundle.args.slice(4), ["--log-order", "grouped", "--output-logs", "new-only"])
			assert.deepEqual(tests.args.slice(4, 8), ["--log-order", "grouped", "--output-logs", "new-only"])
			assert.equal(tests.command, "pnpm")
			assert.deepEqual(tests.args.slice(0, 4), ["exec", "turbo", "run", "test"])
			assert.equal(tests.workers, workers)
			assert.equal(tests.args[tests.args.indexOf("--concurrency") + 1], tasks)
			assert.deepEqual(tests.args.slice(-2), ["--force", "--filter=zoo-code"])
			assert.ok(
				!tests.args.some(
					(arg) =>
						arg === "--" || arg.startsWith("--vitest-workers=") || arg.startsWith("--turbo-concurrency="),
				),
			)
		})
	}

	for (const status of [2, null]) {
		it(`does not start tests after bundle status ${status}`, () => {
			const result = runRunner([], [status, 0])
			assert.equal(result.status, status ?? 1)
			assert.equal(result.calls.length, 1)
		})
	}

	for (const { args, concurrency } of [
		{ args: ["--log-order", "stream", "--output-logs", "full", "--concurrency", "1"], concurrency: "1" },
		{ args: ["--log-order=stream", "--output-logs=full", "--concurrency=1"], concurrency: "1" },
		{ args: ["--log-order=stream"], concurrency: "2" },
		{ args: ["--output-logs=full"], concurrency: "2" },
		{ args: ["--concurrency=1"], concurrency: "1" },
	]) {
		it(`does not repeat caller Turbo options: ${args.join(" ")}`, () => {
			const result = runRunner(args)
			assert.equal(result.status, 0, result.stderr)
			const actual = result.calls[1].args
			for (const flag of ["--log-order", "--output-logs", "--concurrency"]) {
				assert.equal(actual.filter((arg) => arg === flag || arg.startsWith(`${flag}=`)).length, 1)
			}
			assert.deepEqual(actual.slice(-args.length), args)
			assert.match(result.stdout, new RegExp(String.raw`turbo concurrency ${concurrency}(?:\r?\n|$)`))
		})
	}

	it("ignores package options after the separator when selecting Turbo defaults", () => {
		const packageArgs = ["--", "--log-order=package", "--output-logs=package", "--concurrency=package"]
		// The first separator normally comes from pnpm. Supply it explicitly before the package separator.
		const separated = runRunner(["--", ...packageArgs])
		assert.equal(separated.status, 0, separated.stderr)
		assert.deepEqual(separated.calls[1].args.slice(4, 8), ["--log-order", "grouped", "--output-logs", "new-only"])
		assert.deepEqual(separated.calls[1].args.slice(-packageArgs.length), packageArgs)
		assert.match(separated.stdout, /turbo concurrency 2(?:\r?\n|$)/)
	})

	it("keeps a short Turbo flag after a missing wrapper value", () => {
		const result = runRunner(["--vitest-workers", "-F", "worker-probe"])
		assert.equal(result.status, 0, result.stderr)
		assert.equal(result.calls[1].workers, "4")
		assert.deepEqual(result.calls[1].args.slice(-2), ["-F", "worker-probe"])
		assert.match(result.stderr, /Invalid --vitest-workers/)
	})

	it("keeps the next long option after a missing wrapper value", () => {
		const result = runRunner(["--vitest-workers", "--turbo-concurrency=1"])
		assert.equal(result.status, 0, result.stderr)
		assert.equal(result.calls[1].workers, "4")
		assert.match(result.stdout, /turbo concurrency 1(?:\r?\n|$)/)
	})

	it("resets a repeated invalid wrapper flag to its default", () => {
		const result = runRunner([
			"--vitest-workers=1",
			"--vitest-workers=invalid",
			"--turbo-concurrency=1",
			"--turbo-concurrency=invalid",
		])
		assert.equal(result.status, 0, result.stderr)
		assert.equal(result.calls[1].workers, "4")
		assert.match(result.stdout, /turbo concurrency 2(?:\r?\n|$)/)
		assert.match(result.stderr, /Invalid --vitest-workers/)
	})

	it("replaces an inherited worker limit only for tests", () => {
		const result = runRunner(["--vitest-workers=1"], [0, 0], { inheritedWorkers: "9" })
		assert.equal(result.status, 0, result.stderr)
		assert.equal(result.calls[0].workers, "9")
		assert.equal(result.calls[1].workers, "1")
	})

	it("preserves a later separator and package arguments", () => {
		const result = runRunner(["--", "--vitest-workers=1", "--", "--reporter=dot", "--vitest-workers=9"])
		assert.equal(result.status, 0, result.stderr)
		assert.equal(result.calls[1].workers, "1")
		assert.deepEqual(result.calls[1].args.slice(-3), ["--", "--reporter=dot", "--vitest-workers=9"])
	})

	for (const value of ["0", "-1", "invalid", "2junk", "1.5"]) {
		it(`warns and uses defaults for invalid value ${value}`, () => {
			const result = runRunner([`--vitest-workers=${value}`, `--turbo-concurrency=${value}`])
			assert.equal(result.status, 0, result.stderr)
			assert.equal(result.calls[1].workers, "4")
			assert.match(result.stderr, /Invalid --vitest-workers/)
			assert.match(result.stderr, /Invalid --turbo-concurrency/)
		})
	}

	it("prints a process-start error and does not start tests", () => {
		const result = runRunner([], [null], { error: "spawn pnpm ENOENT" })
		assert.equal(result.status, 1)
		assert.equal(result.calls.length, 1)
		assert.match(result.stderr, /Cannot start bundle: spawn pnpm ENOENT/)
	})

	for (const [launcher, executable] of [
		[String.raw`C:\Program Files\pnpm\pnpm.cjs`, false],
		[String.raw`C:\Program Files\pnpm\pnpm.js`, false],
		[String.raw`C:\Program Files\pnpm\pnpm.exe`, true],
	]) {
		it(`accepts Windows launcher ${launcher} without a shell`, () => {
			const result = runRunner(["--filter=package with spaces&literal"], [0, 0], { platform: "win32", launcher })
			assert.equal(result.status, 0, result.stderr)
			for (const call of result.calls) {
				assert.equal(call.command, executable ? launcher : process.execPath)
				assert.equal(call.shell, false)
				assert.deepEqual(call.args.slice(executable ? 0 : 1, executable ? 3 : 4), ["exec", "turbo", "run"])
			}
			assert.equal(result.calls[1].args.at(-1), "--filter=package with spaces&literal")
		})
	}

	for (const launcher of [
		null,
		String.raw`C:\pnpm\pnpm.cmd`,
		String.raw`C:\node\npm-cli.js`,
		String.raw`C:\pnpm\other.exe`,
	]) {
		it(`rejects unsupported Windows launcher ${launcher}`, () => {
			const result = runRunner([], [], { platform: "win32", launcher })
			assert.equal(result.status, 1)
			assert.equal(result.calls.length, 0)
			assert.match(result.stderr, /supported pnpm launcher/)
		})
	}

	it("reports a test-step process-start error", () => {
		const result = runRunner([], [0, null], { errors: [null, "spawn test ENOENT"] })
		assert.equal(result.status, 1)
		assert.equal(result.calls.length, 2)
		assert.match(result.stderr, /Cannot start test: spawn test ENOENT/)
	})

	it("fails when the test process exits by signal", () => {
		const result = runRunner([], [0, null], { signals: [null, "SIGTERM"] })
		assert.equal(result.status, 1)
		assert.equal(result.calls.length, 2)
	})

	it("returns the test process failure", () => {
		const result = runRunner([], [0, 3])
		assert.equal(result.status, 3)
		assert.equal(result.calls.length, 2)
	})
})

const readers = [
	["src/vitest.config.ts", "extension"],
	["webview-ui/vitest.config.ts", "webview"],
]

describe("CI worker config defaults", () => {
	for (const [relative, kind] of readers) {
		it(`keeps existing CI defaults in ${relative}`, () => {
			const filename = path.join(root, relative)
			const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
				compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
			}).outputText
			const script = new vm.Script(compiled, { filename })
			for (const [ci, platform] of [
				["false", "linux"],
				["false", "win32"],
				["true", "linux"],
				["true", "win32"],
			]) {
				const exports = {}
				// Stub config imports only. Execute the actual worker-reading expressions in a fresh context.
				script.runInNewContext({
					exports,
					__dirname: path.dirname(filename),
					process: { env: { CI: ci }, platform },
					require: (name) => {
						if (name === "vitest/config") return { defineConfig: (value) => value }
						if (name === "path") return path
						if (name.endsWith("vitest-verbosity")) return { resolveVerbosity: () => ({}) }
						if (name === "@vitejs/plugin-react") return () => ({})
						throw new Error(`Unexpected configuration import: ${name}`)
					},
				})
				const expected =
					kind === "webview" && ci === "true"
						? 4
						: kind === "extension" && ci === "true" && platform === "win32"
							? 2
							: undefined
				assert.equal(exports.default.test.maxWorkers, expected, `${relative}: ${ci}/${platform}`)
				assert.notEqual(exports.default.test.isolate, false)
			}
		})
	}
})
