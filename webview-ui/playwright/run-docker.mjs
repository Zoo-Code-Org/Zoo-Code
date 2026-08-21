import { spawn, spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const composeFile = path.resolve(dirname, "../docker-compose.visual.yml")

const updateSnapshots = process.argv.includes("--update")
const composeArgs = ["-f", composeFile, "run", "--rm", "visual"]

if (updateSnapshots) {
	// Inlined so host-rendered baselines aren't reachable via a `pnpm` script.
	composeArgs.push(
		"sh",
		"-lc",
		"corepack pnpm --filter @roo-code/vscode-webview exec playwright test -c playwright-ct.config.ts --update-snapshots",
	)
}

// Compose falls back to UID 1000 if not passed; that mis-owns generated files.
const spawnEnv = {
	...process.env,
	UID: String(process.getuid?.() ?? 1000),
	GID: String(process.getgid?.() ?? 1000),
}

const hasComposePlugin = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0
const command = hasComposePlugin ? "docker" : "docker-compose"
const args = hasComposePlugin ? ["compose", ...composeArgs] : composeArgs

const child = spawn(command, args, { stdio: "inherit", env: spawnEnv })

const forwardSignal = (signal) => {
	if (child.pid && !child.killed) {
		child.kill(signal)
	}
}

process.on("SIGINT", () => forwardSignal("SIGINT"))
process.on("SIGTERM", () => forwardSignal("SIGTERM"))

child.on("error", (err) => {
	console.error(`Unable to run ${command}: ${err.message}`)
	process.exit(1)
})

child.on("close", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal)
	} else {
		process.exit(code ?? 1)
	}
})
