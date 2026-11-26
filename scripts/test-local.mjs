#!/usr/bin/env node
// Memory-safe full test run for local and Docker development environments.
//
// The default configuration comes from the benchmarks in issue #2720: four
// Vitest workers per package and two concurrent Turbo tasks. Both values can
// be overridden on constrained containers, for example:
//
//   pnpm test:local -- --vitest-workers=2 --turbo-concurrency=1
//
// Extra arguments are passed through to `turbo run test`, so `--force` and
// `--filter` work as usual. CI is not affected; it runs its own lanes with
// its own worker limits.

import { spawnSync } from "node:child_process"

function parseNumberFlag(args, name) {
	const prefix = `--${name}=`
	const value = args.find((arg) => arg.startsWith(prefix))
	if (!value) return undefined
	const parsed = Number.parseInt(value.slice(prefix.length), 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

// pnpm keeps the `--` separator in argv, and Turbo would forward everything
// after `--` to the package scripts, so drop bare separator tokens.
const args = process.argv.slice(2).filter((arg) => arg !== "--")
const vitestWorkers = parseNumberFlag(args, "vitest-workers") ?? 4
const turboConcurrency = parseNumberFlag(args, "turbo-concurrency") ?? 2
const passthrough = args.filter(
	(arg) => !arg.startsWith("--vitest-workers=") && !arg.startsWith("--turbo-concurrency="),
)

function run(command, commandArgs, env) {
	const result = spawnSync(command, commandArgs, {
		stdio: "inherit",
		env: { ...process.env, ...env },
	})
	if (result.status !== 0) {
		process.exit(result.status ?? 1)
	}
}

console.log(
	`[test:local] bundle (dist assets), then tests with VITEST_MAX_WORKERS=${vitestWorkers} and turbo concurrency ${turboConcurrency}`,
)

// The dist smoke test needs bundled assets. Bundling first avoids the race
// where a concurrent bundle wipes `src/dist` while the extension suite reads it.
run("pnpm", ["exec", "turbo", "run", "bundle", "--log-order", "grouped", "--output-logs", "new-only"])

run(
	"pnpm",
	[
		"exec",
		"turbo",
		"run",
		"test",
		"--concurrency",
		String(turboConcurrency),
		"--log-order",
		"grouped",
		"--output-logs",
		"new-only",
		...passthrough,
	],
	{ VITEST_MAX_WORKERS: String(vitestWorkers) },
)
