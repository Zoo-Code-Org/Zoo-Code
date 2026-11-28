#!/usr/bin/env node
// Bundle assets before local tests. Defaults: four workers per package and two concurrent tasks.
// Both limits are optional. Invalid values use the default and print a warning.
// Extra arguments go only to tests. A later -- separator is preserved.
// The test step replaces an inherited VITEST_MAX_WORKERS value with the selected limit.

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
		: inputArgs[index + 1] && !/^-(?!\d)/.test(inputArgs[index + 1])
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

function turboOption(extraArgs, name) {
	const boundary = extraArgs.indexOf("--")
	const options = boundary < 0 ? extraArgs : extraArgs.slice(0, boundary)
	const index = options.findIndex((arg) => arg === name || arg.startsWith(`${name}=`))
	if (index < 0) return undefined
	return { value: options[index] === name ? options[index + 1] : options[index].slice(name.length + 1) }
}

function runTurbo(task, extraArgs = [], env) {
	const defaults = []
	for (const [name, value] of [
		["--log-order", "grouped"],
		["--output-logs", "new-only"],
	]) {
		if (!turboOption(extraArgs, name)) defaults.push(name, value)
	}
	const turboArgs = ["exec", "turbo", "run", task, ...defaults, ...extraArgs]
	// pnpm.cmd needs a shell. Invoke the active pnpm JavaScript launcher through Node instead.
	const windows = process.platform === "win32"
	const launcher = process.env.npm_execpath
	if (windows && (!launcher || !/(?:^|[\\/])pnpm(?:\.c?js|\.exe)?$/i.test(launcher))) {
		console.error("[test:local] Cannot locate a supported pnpm launcher. Use pnpm.cjs or pnpm.exe.")
		process.exit(1)
	}
	const standalone = windows && /\.exe$/i.test(launcher)
	const command = windows ? (standalone ? launcher : process.execPath) : "pnpm"
	const commandArgs = windows && !standalone ? [launcher, ...turboArgs] : turboArgs
	const result = spawnSync(command, commandArgs, {
		stdio: "inherit",
		env: { ...process.env, ...env },
	})
	if (result.error) console.error(`[test:local] Cannot start ${task}: ${result.error.message}`)
	if (result.error || result.status !== 0) process.exit(result.status ?? 1)
}

const forwardedConcurrency = turboOption(passthrough, "--concurrency")
const testArgs = forwardedConcurrency ? passthrough : ["--concurrency", String(turboConcurrency), ...passthrough]
const effectiveConcurrency = forwardedConcurrency
	? (forwardedConcurrency.value ?? "<missing>")
	: String(turboConcurrency)
console.log(
	`[test:local] bundle (dist assets), then tests with VITEST_MAX_WORKERS=${vitestWorkers} and turbo concurrency ${effectiveConcurrency}`,
)

// The dist smoke test reads bundled assets. Finish bundling before tests can read src/dist.
runTurbo("bundle")
runTurbo("test", testArgs, { VITEST_MAX_WORKERS: String(vitestWorkers) })
