import { spawn } from "child_process"

import { DCG_MAX_OUTPUT_BYTES, DCG_RUN_TIMEOUT_MS } from "./constants"

export type DcgDecision = { decision: "allow" } | { decision: "deny"; reason?: string; ruleId?: string }

type DcgJsonOutput = {
	schema_version?: number | string
	decision?: string
	reason?: string
	rule_id?: string
	pattern_name?: string
	pack_id?: string
}

const DCG_ENV_KEYS = ["HOME", "PATH", "TEMP", "TMPDIR", "TMP", "USERPROFILE", "SystemRoot", "WINDIR"] as const

function getDcgEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { NO_COLOR: "1" }
	for (const key of DCG_ENV_KEYS) {
		if (process.env[key] !== undefined) env[key] = process.env[key]
	}
	return env
}

export function runDcg(binaryPath: string, command: string, cwd: string): Promise<DcgDecision> {
	return new Promise((resolve, reject) => {
		const child = spawn(binaryPath, ["test", "--format", "json", "--no-color", command], {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: getDcgEnvironment(),
		})
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
		let settled = false
		const fail = (error: Error, killChild = true) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (killChild) child.kill("SIGKILL")
			console.warn("[DCG]", error.message)
			reject(error)
		}
		const appendOutputOrFail = (
			current: Buffer<ArrayBufferLike>,
			chunk: Buffer<ArrayBufferLike>,
		): Buffer<ArrayBufferLike> => {
			if (current.length + chunk.length > DCG_MAX_OUTPUT_BYTES) {
				fail(new Error("DCG produced too much output"))
				return current
			}
			return Buffer.concat([current, chunk])
		}
		const timer = setTimeout(() => fail(new Error("DCG evaluation timed out")), DCG_RUN_TIMEOUT_MS)
		child.stdout?.on("data", (chunk: Buffer) => (stdout = appendOutputOrFail(stdout, chunk)))
		child.stderr?.on("data", (chunk: Buffer) => (stderr = appendOutputOrFail(stderr, chunk)))
		child.on("error", (error) => fail(new Error(`Unable to start DCG: ${error.message}`)))
		child.on("close", (code, signal) => {
			if (settled) return
			if (signal || (code !== 0 && code !== 1)) {
				fail(new Error(`DCG evaluation failed${stderr.length ? `: ${stderr.toString().trim()}` : ""}`), false)
				return
			}

			let payload: DcgJsonOutput
			try {
				payload = JSON.parse(stdout.toString("utf8")) as DcgJsonOutput
			} catch {
				fail(new Error("DCG returned invalid JSON"), false)
				return
			}

			const schemaVersion = Number(payload.schema_version)
			if (![1, 2].includes(schemaVersion)) {
				fail(new Error("DCG returned an unsupported response schema"), false)
				return
			}
			if (payload.decision === "allow" && code === 0) {
				settled = true
				clearTimeout(timer)
				resolve({ decision: "allow" })
			} else if (payload.decision === "deny" && code === 1) {
				settled = true
				clearTimeout(timer)
				console.warn("[DCG] Command denied", payload.reason ?? "No reason provided")
				resolve({
					decision: "deny",
					reason: payload.reason,
					ruleId:
						payload.rule_id ??
						(payload.pack_id && payload.pattern_name
							? `${payload.pack_id}:${payload.pattern_name}`
							: undefined),
				})
			} else {
				fail(new Error("DCG decision did not match its exit status"), false)
			}
		})
	})
}
