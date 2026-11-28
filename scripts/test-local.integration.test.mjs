import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "node:test"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const fixtures = path.join(root, "scripts/fixtures/local-test-runner")
const launcher = process.env.npm_execpath
const scriptLauncher = launcher && /\.c?js$/i.test(launcher)
const command = scriptLauncher ? process.execPath : (launcher ?? "pnpm")
const prefix = scriptLauncher ? [launcher] : []

// Run the unmodified runner, installed Turbo, and installed Vitest. Fixture data never becomes source code.
for (const { name, workers, args, concurrency, packageArgs } of [
	{ name: "defaults", workers: 4, args: [], concurrency: "2", packageArgs: [] },
	{
		name: "equals Turbo overrides",
		workers: 1,
		concurrency: "1",
		packageArgs: [],
		args: ["--vitest-workers=1", "--log-order=stream", "--output-logs=full", "--concurrency=1"],
	},
	{
		name: "space Turbo overrides",
		workers: 3,
		concurrency: "1",
		packageArgs: [],
		args: ["--vitest-workers", "3", "--log-order", "stream", "--output-logs", "full", "--concurrency", "1"],
	},
	{
		name: "missing wrapper value before short filter",
		workers: 4,
		concurrency: "2",
		packageArgs: [],
		args: ["--vitest-workers", "-F", "worker-probe"],
	},
	{
		name: "package flags after separator",
		workers: 4,
		concurrency: "2",
		args: ["--", "--log-order=package-value", "--concurrency=package-value"],
		packageArgs: ["--log-order=package-value", "--concurrency=package-value"],
	},
]) {
	it(`runs the real runner through strict Turbo and Vitest with ${name}`, () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-turbo-contract-"))
		try {
			const probe = path.join(directory, "packages/probe")
			fs.mkdirSync(path.join(directory, "scripts"), { recursive: true })
			fs.cpSync(fixtures, probe, { recursive: true })
			fs.copyFileSync(path.join(root, "scripts/test-local.mjs"), path.join(directory, "scripts/test-local.mjs"))
			fs.writeFileSync(
				path.join(directory, "package.json"),
				JSON.stringify({
					name: "runner-probe",
					private: true,
					packageManager: manifest.packageManager,
					scripts: { "test:local": "node scripts/test-local.mjs" },
				}),
			)
			fs.writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
			fs.writeFileSync(
				path.join(directory, "pnpm-lock.yaml"),
				"lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/probe: {}\n",
			)
			const config = JSON.parse(fs.readFileSync(path.join(root, "turbo.json"), "utf8"))
			fs.writeFileSync(
				path.join(directory, "turbo.json"),
				JSON.stringify({
					globalPassThroughEnv: config.globalPassThroughEnv ?? [],
					tasks: { bundle: { cache: false }, test: { cache: false } },
				}),
			)
			fs.writeFileSync(
				path.join(probe, "package.json"),
				JSON.stringify({
					name: "worker-probe",
					private: true,
					scripts: { bundle: "node bundle.mjs", test: "node run-vitest.mjs" },
				}),
			)
			const output = path.join(directory, "resolved.json")
			fs.writeFileSync(
				path.join(probe, "runner-data.json"),
				JSON.stringify({
					vitest: path.join(root, "src/node_modules/vitest/vitest.mjs"),
					output,
					workers,
				}),
			)
			const result = spawnSync(command, [...prefix, "run", "test:local", "--", ...args], {
				cwd: directory,
				env: {
					...process.env,
					PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
					TURBO_ENV_MODE: "strict",
					TURBO_TELEMETRY_DISABLED: "1",
					VITEST_MAX_WORKERS: "9",
				},
				encoding: "utf8",
				timeout: 60_000,
			})
			assert.ifError(result.error)
			assert.equal(result.status, 0, result.stdout + result.stderr)
			assert.match(result.stdout, new RegExp(String.raw`turbo concurrency ${concurrency}(?:\r?\n|$)`))
			assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
				workers,
				isolate: true,
				value: String(workers),
			})
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(probe, "package-args.json"), "utf8")), packageArgs)
		} finally {
			fs.rmSync(directory, { recursive: true, force: true })
		}
	})
}
