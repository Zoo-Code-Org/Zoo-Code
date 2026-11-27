import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { it } from "node:test"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const turbo = require.resolve("turbo")
const vitest = path.join(root, "src/node_modules/vitest/vitest.mjs")

// Exercise the actual strict environment boundary and the installed Vitest version.
for (const workers of [1, 3]) {
	it(`forwards worker limit ${workers} through strict Turbo into Vitest`, () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-turbo-contract-"))
		try {
			const probe = path.join(directory, "packages/probe")
			fs.mkdirSync(probe, { recursive: true })
			fs.writeFileSync(
				path.join(directory, "package.json"),
				JSON.stringify({ name: "runner-probe", private: true, packageManager: "pnpm@10.8.1" }),
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
					tasks: { test: { cache: false } },
				}),
			)
			fs.writeFileSync(
				path.join(probe, "package.json"),
				JSON.stringify({ name: "worker-probe", private: true, scripts: { test: "node run-vitest.mjs" } }),
			)
			fs.writeFileSync(
				path.join(probe, "run-vitest.mjs"),
				`
				import { spawnSync } from "node:child_process";
				const result = spawnSync(process.execPath, [${JSON.stringify(vitest)}, "run", "--config", "vitest.config.mjs"], { stdio: "inherit", env: process.env });
				if (result.error) throw result.error;
				process.exit(result.status ?? 1);
			`,
			)
			fs.writeFileSync(
				path.join(probe, "vitest.config.mjs"),
				`export default { test: { globals: true, maxWorkers: 7, pool: "forks", globalSetup: "./setup.mjs" } };`,
			)
			const output = path.join(directory, "resolved.json")
			fs.writeFileSync(
				path.join(probe, "setup.mjs"),
				`
				import { writeFileSync } from "node:fs";
				export default (project) => writeFileSync(${JSON.stringify(output)}, JSON.stringify({ workers: project.config.maxWorkers, isolate: project.config.isolate, value: process.env.VITEST_MAX_WORKERS }));
			`,
			)
			fs.writeFileSync(
				path.join(probe, "probe.test.js"),
				`test("worker receives limit", () => expect(process.env.VITEST_MAX_WORKERS).toBe(${JSON.stringify(String(workers))}));`,
			)
			const result = spawnSync(
				process.execPath,
				[turbo, "run", "test", "--env-mode=strict", "--force", "--no-daemon"],
				{
					cwd: directory,
					env: { ...process.env, VITEST_MAX_WORKERS: String(workers), TURBO_TELEMETRY_DISABLED: "1" },
					encoding: "utf8",
					timeout: 60_000,
				},
			)
			assert.ifError(result.error)
			assert.equal(result.status, 0, result.stdout + result.stderr)
			assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
				workers,
				isolate: true,
				value: String(workers),
			})
		} finally {
			fs.rmSync(directory, { recursive: true, force: true })
		}
	})
}
