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
function runRunner(args = [], statuses = [0, 0]) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-runner-test-"))
	try {
		const log = path.join(directory, "calls.jsonl")
		const preload = path.join(directory, "process-double.mjs")
		fs.writeFileSync(
			preload,
			`import childProcess from "node:child_process";
			import { appendFileSync } from "node:fs";
			import { syncBuiltinESMExports } from "node:module";
			let index = 0;
			const statuses = JSON.parse(process.env.LOCAL_RUNNER_STATUSES);
			childProcess.spawnSync = (command, args, options) => {
				appendFileSync(process.env.LOCAL_RUNNER_LOG, JSON.stringify({
					command, args, workers: options.env.VITEST_MAX_WORKERS
				}) + "\\n");
				return { status: statuses[index++] };
			};
			syncBuiltinESMExports();`,
		)
		const env = { ...process.env, LOCAL_RUNNER_LOG: log, LOCAL_RUNNER_STATUSES: JSON.stringify(statuses) }
		delete env.VITEST_MAX_WORKERS
		const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, runner, ...args], {
			env,
			encoding: "utf8",
		})
		assert.ifError(result.error)
		const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)
		return { status: result.status, calls, stderr: result.stderr }
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
}

describe("local test runner contract", () => {
	for (const { name, args, workers, tasks } of [
		{ name: "defaults", args: [], workers: "4", tasks: "2" },
		{ name: "overrides", args: ["--", "--vitest-workers=2", "--turbo-concurrency=1"], workers: "2", tasks: "1" },
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

	it("keeps forwarded logging options after the runner defaults", () => {
		const result = runRunner(["--log-order", "stream", "--output-logs", "full"])
		assert.equal(result.status, 0, result.stderr)
		const args = result.calls[1].args
		assert.equal(args[args.lastIndexOf("--log-order") + 1], "stream")
		assert.equal(args[args.lastIndexOf("--output-logs") + 1], "full")
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
	["apps/cli/vitest.config.ts", "package"],
	["packages/core/vitest.config.ts", "package"],
	["packages/core/vitest.unit.config.ts", "package"],
	["packages/core/vitest.integration.config.ts", "package"],
	["packages/cloud/vitest.config.ts", "package"],
	["packages/telemetry/vitest.config.ts", "package"],
	["packages/types/vitest.config.ts", "package"],
	["packages/vscode-shim/vitest.config.ts", "package"],
]

describe("Vitest worker limit readers", () => {
	for (const [relative, kind] of readers) {
		it(`keeps local limits and fixed CI limits in ${relative}`, () => {
			const filename = path.join(root, relative)
			const compiled = ts.transpileModule(
				fs
					.readFileSync(filename, "utf8")
					.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(filename).href)),
				{
					compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
				},
			).outputText
			const script = new vm.Script(compiled, { filename })
			for (const workers of [undefined, "2", "0", "invalid"]) {
				for (const [ci, platform] of [
					["false", "linux"],
					["true", "linux"],
					["true", "win32"],
				]) {
					const exports = {}
					// Stub config imports only. Execute the actual worker-reading expressions in a fresh context.
					script.runInNewContext({
						exports,
						URL,
						__dirname: path.dirname(filename),
						process: { env: { CI: ci, VITEST_MAX_WORKERS: workers }, platform },
						require: (name) => {
							if (name === "vitest/config")
								return { defineConfig: (value) => value, configDefaults: { exclude: [] } }
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
								: workers === "2"
									? 2
									: undefined
					assert.equal(exports.default.test.maxWorkers, expected, `${relative}: ${ci}/${platform}/${workers}`)
					assert.notEqual(exports.default.test.isolate, false)
				}
			}
		})
	}
})
