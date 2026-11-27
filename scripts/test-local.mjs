#!/usr/bin/env node
// Bundle assets before local tests. Defaults: four workers per package and two concurrent tasks.
// Both limits are optional. Invalid values use the default and print a warning.
// Turbo arguments follow the wrapper options. A later -- separator is preserved.

import { spawnSync } from "node:child_process"

const inputArgs = process.argv.slice(2)
if (inputArgs[0] === "--") inputArgs.shift()
const defaultLimits = { "--vitest-workers": 4, "--turbo-concurrency": 2 }
const limits = { ...defaultLimits }
const passthrough = []
for (let index = 0; index < inputArgs.length; index++) {
	const arg = inputArgs[index]
	if (arg === "--") {
		passthrough.push(...inputArgs.slice(index))
		break
	}
	const name = arg.split("=", 1)[0]
	if (!Object.hasOwn(limits, name)) {
		passthrough.push(arg)
		continue
	}
	const value = arg.includes("=")
		? arg.slice(name.length + 1)
		: inputArgs[index + 1] && !inputArgs[index + 1].startsWith("--")
			? inputArgs[++index]
			: undefined
	const parsed = Number(value)
	if (value && Number.isSafeInteger(parsed) && parsed > 0) {
		limits[name] = parsed
	} else {
		const fallback = defaultLimits[name]
		console.warn(`[test:local] Invalid ${name} value ${JSON.stringify(value ?? "")}. Using ${fallback}.`)
		limits[name] = fallback
	}
}
const vitestWorkers = limits["--vitest-workers"]
const turboConcurrency = limits["--turbo-concurrency"]

function runTurbo(task, extraArgs = [], env) {
	const turboArgs = [
		"exec",
		"turbo",
		"run",
		task,
		"--log-order",
		"grouped",
		"--output-logs",
		"new-only",
		...extraArgs,
	]
	// pnpm.cmd needs a shell. Invoke the active pnpm JavaScript launcher through Node instead.
	const windows = process.platform === "win32"
	const launcher = process.env.npm_execpath
	if (windows && (!launcher || !/(?:^|[\\/])pnpm(?:\.c?js)?$/i.test(launcher))) {
		console.error("[test:local] Cannot locate the pnpm launcher. Run pnpm test:local.")
		process.exit(1)
	}
	const result = spawnSync(windows ? process.execPath : "pnpm", windows ? [launcher, ...turboArgs] : turboArgs, {
		stdio: "inherit",
		env: { ...process.env, ...env },
	})
	if (result.error) console.error(`[test:local] Cannot start ${task}: ${result.error.message}`)
	if (result.error || result.status !== 0) process.exit(result.status ?? 1)
}

console.log(
	`[test:local] bundle (dist assets), then tests with VITEST_MAX_WORKERS=${vitestWorkers} and turbo concurrency ${turboConcurrency}`,
)

// The dist smoke test reads bundled assets. Finish bundling before tests can read src/dist.
runTurbo("bundle")
runTurbo("test", ["--concurrency", String(turboConcurrency), ...passthrough], {
	VITEST_MAX_WORKERS: String(vitestWorkers),
})
