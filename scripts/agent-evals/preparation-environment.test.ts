import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { it } from "node:test"
import { runBoundedPreparation } from "./coding-compare.ts"
import { createSideProcessGuard } from "./side-process-guard.ts"

it("preparation children use isolated home and npm configuration without registry credentials", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preparation-env-"))
	const names = ["HOME", "XDG_CONFIG_HOME", "npm_config_registry"] as const
	const saved = names.map((name) => process.env[name])
	try {
		await fs.writeFile(path.join(dir, ".npmrc"), "//registry.example/:_authToken=private-token")
		process.env["HOME"] = dir
		process.env["XDG_CONFIG_HOME"] = dir
		process.env["npm_config_registry"] = "https://user:private-token@registry.example/"
		await runBoundedPreparation(
			createSideProcessGuard(100),
			() => false,
			process.execPath,
			[
				"-e",
				`
			const fs = require("node:fs")
			const path = require("node:path")
			fs.writeFileSync("observed.json", JSON.stringify({
				home: process.env.HOME,
				config: process.env.XDG_CONFIG_HOME,
				registry: process.env.npm_config_registry ?? null,
				npmrcExists: fs.existsSync(path.join(process.env.HOME, ".npmrc")),
				userconfig: process.env.npm_config_userconfig,
				globalconfig: process.env.npm_config_globalconfig,
			}))
		`,
			],
			dir,
			5000,
		)
		const observed = JSON.parse(await fs.readFile(path.join(dir, "observed.json"), "utf8")) as {
			home: string
			config: string
			registry: unknown
			npmrcExists: boolean
			userconfig: string
			globalconfig: string
		}
		assert.notEqual(observed.home, dir)
		assert.ok(observed.config.startsWith(observed.home + "/"))
		assert.equal(observed.registry, null)
		assert.equal(observed.npmrcExists, false)
		assert.equal(observed.userconfig, path.join(observed.home, ".npmrc"))
		assert.equal(observed.globalconfig, path.join(observed.home, "global-npmrc"))
		await assert.rejects(fs.access(observed.home))
	} finally {
		for (const [index, name] of names.entries()) {
			const value = saved[index]
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
		await fs.rm(dir, { recursive: true, force: true })
	}
})

it("kills background preparation workers after their parent succeeds", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preparation-worker-"))
	const heartbeat = path.join(dir, "heartbeat")
	const pidFile = path.join(dir, "worker-pid")
	try {
		const worker =
			"const fs = require('node:fs'); const file = process.argv[1]; fs.writeFileSync(file, 'x'); process.stdout.write('ready'); setInterval(() => fs.appendFileSync(file, 'x'), 20)"
		await runBoundedPreparation(
			createSideProcessGuard(100),
			() => false,
			process.execPath,
			[
				"-e",
				`const { spawn } = require('node:child_process');
			const fs = require('node:fs');
			const [worker, heartbeat, pidFile] = process.argv.slice(1);
			const child = spawn(process.execPath, ['-e', worker, heartbeat], { stdio: ['ignore', 'pipe', 'ignore'] });
			fs.writeFileSync(pidFile, String(child.pid));
			child.stdout.once('data', () => process.exit(0));`,
				worker,
				heartbeat,
				pidFile,
			],
			dir,
			5000,
		)
		const before = (await fs.stat(heartbeat)).size
		await new Promise((resolve) => setTimeout(resolve, 200))
		assert.equal((await fs.stat(heartbeat)).size, before)
	} finally {
		const pid = await fs.readFile(pidFile, "utf8").then(Number, () => undefined)
		if (pid !== undefined) {
			try {
				process.kill(pid, "SIGKILL")
			} catch {
				/* Already exited. */
			}
		}
		await fs.rm(dir, { recursive: true, force: true })
	}
})
