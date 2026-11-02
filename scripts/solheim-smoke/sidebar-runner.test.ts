import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { describe, it } from "node:test"
import vm from "node:vm"

const source = await fs.readFile(new URL("./sidebar-runner.cjs", import.meta.url), "utf8")

describe("sidebar recording diagnostics", () => {
	for (const scenario of ["ready", "focus-failed", "extension-missing", "write-failed"] as const) {
		it(`persists bounded evidence and keeps the host pending for ${scenario}`, async () => {
			const writes: { target: string; body: string }[] = []
			const commands: string[] = []
			const exports: { run?: () => Promise<void> } = {}
			const context = vm.createContext({
				exports,
				process: { env: { AGENT_EVALS_TESTS_DIAGNOSTICS_PATH: "/artifacts/sidebar-focus.json" } },
				require(name: string) {
					if (name === "node:fs/promises")
						return {
							async writeFile(target: string, body: string) {
								if (scenario === "write-failed") throw new Error("private filesystem detail")
								writes.push({ target, body })
							},
						}
					assert.equal(name, "vscode")
					return {
						extensions: {
							getExtension: () =>
								scenario === "extension-missing"
									? undefined
									: {
											isActive: true,
											exports: { isReady: () => true },
										},
						},
						commands: {
							async executeCommand(command: string) {
								commands.push(command)
								if (scenario === "focus-failed") throw new Error("private activation detail")
							},
						},
					}
				},
			})
			vm.runInContext(source, context)
			assert.ok(exports.run)
			let settled = false
			void exports.run().then(
				() => {
					settled = true
				},
				() => {
					settled = true
				},
			)
			// Flush async focus and file writes without waiting for the intentionally pending run().
			await new Promise<void>((resolve) => setImmediate(resolve))
			assert.equal(settled, false)
			assert.deepEqual(commands, scenario === "extension-missing" ? [] : ["zoo-code.SidebarProvider.focus"])
			assert.deepEqual(
				writes,
				scenario === "write-failed"
					? []
					: [
							{
								target: "/artifacts/sidebar-focus.json",
								body: JSON.stringify({ status: scenario === "ready" ? "ready" : "failed" }),
							},
						],
			)
		})
	}
})
