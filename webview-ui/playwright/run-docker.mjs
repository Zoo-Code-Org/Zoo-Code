import { spawnSync } from "node:child_process"

const updateSnapshots = process.argv.includes("--update")
const composeArgs = ["-f", "docker-compose.visual.yml", "run", "--rm", "visual"]

if (updateSnapshots) {
	composeArgs.push("sh", "-lc", "corepack pnpm --filter @roo-code/vscode-webview test:visual:update")
}

const hasComposePlugin = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0
const command = hasComposePlugin ? "docker" : "docker-compose"
const args = hasComposePlugin ? ["compose", ...composeArgs] : composeArgs
const result = spawnSync(command, args, { stdio: "inherit" })

if (result.error) {
	console.error(`Unable to run ${command}: ${result.error.message}`)
	process.exit(1)
}

process.exit(result.status ?? 1)
