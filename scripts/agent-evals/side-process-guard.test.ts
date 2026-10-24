import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { runBoundedPreparation } from "./coding-compare.ts"
import { createInterruptFlag, createSideProcessGuard, groupAlive, type SideKillOutcome } from "./side-process-guard.ts"

// Credential-free process fixtures. Each child is a bare node process in its
// own detached group, the same topology the comparison driver creates.
const spawnDetachedChild = (script: string, args: readonly string[] = []) => {
	const child = spawn(process.execPath, ["-e", script, ...args], {
		stdio: ["ignore", "pipe", "ignore"],
		detached: true,
	})
	const spawned = new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve)
		child.once("error", reject)
	})
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
	// Resolves when the child reports readiness, so a signal cannot land
	// before the child finished its own setup.
	const ready = new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", () => resolve())
		child.once("error", reject)
		child.once("exit", () => reject(new Error("child exited before reporting readiness")))
	})
	// Tests that never await readiness still keep the rejection handled.
	ready.catch(() => {})
	return { child, spawned, ready, exited }
}

describe("side process guard", () => {
	it("resolves without work when nothing is tracked", async () => {
		const guard = createSideProcessGuard(1_000)
		assert.equal(await guard.interrupt(), "none")
		// Repeated interrupts are no-ops, never a double kill.
		assert.equal(await guard.interrupt(), "none")
	})

	it("terminates a detached child group on SIGTERM", { timeout: 30_000 }, async () => {
		const guard = createSideProcessGuard(10_000)
		const { child, spawned, exited } = spawnDetachedChild("setInterval(() => {}, 1000000)")
		try {
			await spawned
			guard.track(child.pid)
			assert.equal(await guard.interrupt(), "terminated")
			// The detached child must actually be gone, not orphaned.
			await Promise.race([
				exited,
				new Promise((_, reject) => setTimeout(() => reject(new Error("child survived the interrupt")), 20_000)),
			])
		} finally {
			child.kill("SIGKILL")
		}
	})

	it("escalates to SIGKILL when the child ignores SIGTERM", { timeout: 30_000 }, async () => {
		const guard = createSideProcessGuard(300)
		const { child, ready, exited } = spawnDetachedChild(
			"process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000000)",
		)
		try {
			// The signal must not land before the child installed its ignore
			// handler.
			await ready
			guard.track(child.pid)
			assert.equal(await guard.interrupt(), "killed")
			await Promise.race([
				exited,
				new Promise((_, reject) => setTimeout(() => reject(new Error("child survived SIGKILL")), 20_000)),
			])
		} finally {
			child.kill("SIGKILL")
		}
	})

	it("runs the escalation once across repeated calls", { timeout: 30_000 }, async () => {
		const guard = createSideProcessGuard(10_000)
		const { child, spawned, exited } = spawnDetachedChild("setInterval(() => {}, 1000000)")
		try {
			await spawned
			guard.track(child.pid)
			const first = guard.interrupt()
			// A second signal must not start a second kill sequence.
			assert.equal(await guard.interrupt(), "none")
			assert.equal(await first, "terminated")
			await exited
		} finally {
			child.kill("SIGKILL")
		}
	})

	it("keeps the escalation running when the tracked child exits mid-wait", { timeout: 30_000 }, async () => {
		// The runner untracks the direct child as soon as it settles. The
		// group id is snapshotted at interrupt time, so that untrack cannot
		// cut the wait short while a group member still writes.
		const guard = createSideProcessGuard(500)
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "guard-escalation-test-"))
		const grandchildHeartbeat = path.join(dir, "grandchild-heartbeat")
		const grandchildPidPath = path.join(dir, "grandchild-pid")
		const grandchildReadyPath = path.join(dir, "grandchild-ready")
		// Fixture sources stay static. Host paths and the grandchild source
		// travel as argv, so no host value is embedded in generated code.
		const grandchildScript =
			"const fs = require('node:fs'); process.on('SIGTERM', () => {}); const [heartbeatPath, readyPath] = process.argv.slice(1); fs.writeFileSync(readyPath, 'ready'); setInterval(() => fs.appendFileSync(heartbeatPath, 'x'), 50)"
		const fixture = spawnDetachedChild(
			`const fs = require('node:fs');
			const { spawn } = require('node:child_process');
			const [grandchildPidPath, grandchildReadyPath, grandchildHeartbeatPath, grandchildScript] = process.argv.slice(1);
			const grandchild = spawn(process.execPath, ['-e', grandchildScript, grandchildHeartbeatPath, grandchildReadyPath], { stdio: 'ignore' });
			fs.writeFileSync(grandchildPidPath, String(grandchild.pid));
			process.stdout.write('ready');
			setTimeout(() => process.exit(0), 100);`,
			[grandchildPidPath, grandchildReadyPath, grandchildHeartbeat, grandchildScript],
		)
		try {
			// The signal must not land before the grandchild installed its
			// ignore handler, so both fixture processes report readiness.
			await Promise.all([fixture.ready, waitForFile(grandchildReadyPath)])
			const childPid = fixture.child.pid
			assert.ok(childPid !== undefined)
			guard.track(childPid)
			const interrupt = guard.interrupt()
			// The direct child settles and the runner untracks it while the
			// grandchild, which ignores SIGTERM, still lives.
			await fixture.exited
			guard.track(undefined)
			assert.equal(await interrupt, "killed")
			// The SIGKILL escalation reached the surviving group member: its
			// heartbeat went silent.
			await assertHeartbeatStopped(grandchildHeartbeat)
		} finally {
			fixture.child.kill("SIGKILL")
			const grandchildPid = await fs.readFile(grandchildPidPath, "utf8").then(Number, () => undefined)
			if (grandchildPid !== undefined) {
				try {
					process.kill(grandchildPid, "SIGKILL")
				} catch {
					/* Already gone. */
				}
			}
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
	})
})

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Confirms the fixture writer stopped appending, so no child is still
// writing when the driver's cleanup would run.
const assertHeartbeatStopped = async (filePath: string): Promise<void> => {
	const sizeBefore = await fs.stat(filePath).then(
		(entry) => entry.size,
		() => -1,
	)
	await delay(400)
	const sizeAfter = await fs.stat(filePath).then(
		(entry) => entry.size,
		() => -1,
	)
	assert.equal(sizeAfter, sizeBefore)
}

// Polls until the file exists, so a signal cannot land before the fixture
// children finished their own setup.
const waitForFile = async (filePath: string): Promise<void> => {
	const deadline = Date.now() + 10_000
	while (Date.now() < deadline) {
		if (
			await fs.access(filePath).then(
				() => true,
				() => false,
			)
		)
			return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error(`fixture file never appeared: ${filePath}`)
}

describe("bounded preparation children", () => {
	// Regression: a SIGTERM aimed at the driver process alone used to leave
	// install and build children running, because only the coding side was
	// tracked. The test replays the driver wiring credential-free: one guard,
	// one handler that arms one escalation, and a cleanup that waits for it.
	it("stops a tracked preparation group when only the parent gets SIGTERM", { timeout: 30_000 }, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-prep-test-"))
		const guard = createSideProcessGuard(2_000)
		let interruptSignal: NodeJS.Signals | undefined
		let interruptKill: Promise<SideKillOutcome> | undefined
		const onInterruptSignal = (signal: NodeJS.Signals): void => {
			if (interruptSignal !== undefined) return
			interruptSignal = signal
			interruptKill = guard.interrupt()
		}
		process.on("SIGTERM", onInterruptSignal)
		// The preparation child leads its own group and spawns a grandchild
		// into it, the same topology a real pnpm install creates. Both keep
		// writing a heartbeat file, so a surviving member cannot hide.
		const readyPath = path.join(dir, "ready")
		const childPidPath = path.join(dir, "child-pid")
		const childHeartbeat = path.join(dir, "child-heartbeat")
		const grandchildHeartbeat = path.join(dir, "grandchild-heartbeat")
		// Fixture sources stay static. Host paths and the grandchild source
		// travel as argv, so no host value is embedded in generated code.
		const grandchildScript =
			"const fs = require('node:fs'); const [heartbeatPath] = process.argv.slice(1); setInterval(() => fs.appendFileSync(heartbeatPath, 'x'), 50)"
		const childScript = [
			"const fs = require('node:fs')",
			"const { spawn } = require('node:child_process')",
			"const [childPidPath, readyPath, childHeartbeatPath, grandchildHeartbeatPath, grandchildScript] = process.argv.slice(1)",
			"fs.writeFileSync(childPidPath, String(process.pid))",
			"const grandchild = spawn(process.execPath, ['-e', grandchildScript, grandchildHeartbeatPath], { stdio: 'ignore' })",
			"fs.writeFileSync(readyPath, 'ready')",
			"setInterval(() => fs.appendFileSync(childHeartbeatPath, 'x'), 50)",
		].join("; ")
		// Security regression guard: generated fixture code must not embed
		// any host path. Every host value travels as argv instead.
		assert.ok(!childScript.includes(dir))
		const bounded = runBoundedPreparation(
			guard,
			() => interruptSignal !== undefined,
			process.execPath,
			["-e", childScript, childPidPath, readyPath, childHeartbeat, grandchildHeartbeat, grandchildScript],
			dir,
			60_000,
		)
		try {
			await waitForFile(readyPath)
			// The signal targets this test process alone. The child group
			// receives nothing from this kill call.
			process.kill(process.pid, "SIGTERM")
			await assert.rejects(bounded)
			// The escalation finishes before any cleanup runs, and the whole
			// group, grandchild included, is gone by then.
			await interruptKill
			assert.equal(interruptSignal, "SIGTERM")
			// The whole group went silent before the cleanup ran, so nothing
			// survives to write into the removed tree.
			await assertHeartbeatStopped(childHeartbeat)
			await assertHeartbeatStopped(grandchildHeartbeat)
			await fs.rm(dir, { recursive: true, force: true })
		} finally {
			process.removeListener("SIGTERM", onInterruptSignal)
			const childPid = await fs.readFile(childPidPath, "utf8").then(Number, () => undefined)
			if (childPid !== undefined) {
				try {
					process.kill(-childPid, "SIGKILL")
				} catch {
					/* The group is already gone. */
				}
			}
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
	})

	it("refuses to start a preparation child after the interrupt", { timeout: 30_000 }, async () => {
		const guard = createSideProcessGuard(100)
		// A signal that landed between children tracked nothing; the next
		// spawn must refuse instead of escaping the stop.
		assert.equal(await guard.interrupt(), "none")
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-prep-test-"))
		try {
			await assert.rejects(
				runBoundedPreparation(
					guard,
					() => true,
					process.execPath,
					["-e", "setInterval(() => {}, 1000000)"],
					dir,
					1_000,
				),
				/interrupted before/,
			)
		} finally {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
	})
})

describe("group liveness probe", () => {
	it("reports a live process group as alive", { timeout: 30_000 }, async () => {
		const { child, spawned } = spawnDetachedChild("setInterval(() => {}, 1000000)")
		try {
			await spawned
			assert.ok(child.pid !== undefined)
			assert.equal(groupAlive(child.pid), true)
		} finally {
			child.kill("SIGKILL")
		}
	})

	it("reports a gone process group as gone", { timeout: 30_000 }, async () => {
		const { child, spawned, exited } = spawnDetachedChild("process.exit(0)")
		await spawned
		await exited
		assert.ok(child.pid !== undefined)
		assert.equal(groupAlive(child.pid), false)
	})

	it("treats a refused probe as an alive group so the escalation continues", () => {
		const throwCode = (code: string) => () => {
			throw Object.assign(new Error(`probe refused: ${code}`), { code })
		}
		// EPERM means the group exists but the probe was not allowed.
		assert.equal(groupAlive(123_456, throwCode("EPERM")), true)
		// Any other error is not proof of absence either.
		assert.equal(
			groupAlive(123_456, () => {
				throw new Error("probe failed")
			}),
			true,
		)
		// Only ESRCH proves the group is gone.
		assert.equal(groupAlive(123_456, throwCode("ESRCH")), false)
	})
})

describe("side interrupt flag", () => {
	it("arms at most once and keeps the first signal", () => {
		const flag = createInterruptFlag()
		assert.equal(flag.isInterrupted(), false)
		assert.equal(flag.exitCode(), 1)
		flag.signal("SIGINT")
		// A later signal must not un-arm or replace the first one.
		flag.signal("SIGTERM")
		assert.equal(flag.isInterrupted(), true)
		assert.equal(flag.name(), "SIGINT")
		assert.equal(flag.exitCode(), 130)
	})

	it("maps SIGTERM to its conventional exit code", () => {
		const flag = createInterruptFlag()
		flag.signal("SIGTERM")
		assert.equal(flag.name(), "SIGTERM")
		assert.equal(flag.exitCode(), 143)
	})
})
