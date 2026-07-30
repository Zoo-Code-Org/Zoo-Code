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

export function runDcg(binaryPath: string, command: string, cwd: string): Promise<DcgDecision> {
	return new Promise((resolve, reject) => {
		const child = spawn(binaryPath, ["test", "--format", "json", "--no-color", command], {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		})
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
		let settled = false
		const fail = (error: Error) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.kill("SIGKILL")
			reject(error)
		}
		const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
			if (current.length + chunk.length > DCG_MAX_OUTPUT_BYTES) {
				fail(new Error("DCG produced too much output"))
				return current
			}
			return Buffer.concat([current, chunk])
		}
		const timer = setTimeout(() => fail(new Error("DCG evaluation timed out")), DCG_RUN_TIMEOUT_MS)
		child.stdout?.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)))
		child.stderr?.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)))
		child.on("error", (error) => fail(new Error(`Unable to start DCG: ${error.message}`)))
		child.on("close", (code, signal) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (signal || (code !== 0 && code !== 1)) {
				reject(new Error(`DCG evaluation failed${stderr.length ? `: ${stderr.toString().trim()}` : ""}`))
				return
			}

			let payload: DcgJsonOutput
			try {
				payload = JSON.parse(stdout.toString("utf8")) as DcgJsonOutput
			} catch {
				reject(new Error("DCG returned invalid JSON"))
				return
			}

			const schemaVersion = Number(payload.schema_version)
			if (![1, 2].includes(schemaVersion)) {
				reject(new Error("DCG returned an unsupported response schema"))
				return
			}
			if (payload.decision === "allow" && code === 0) {
				resolve({ decision: "allow" })
			} else if (payload.decision === "deny" && code === 1) {
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
				reject(new Error("DCG decision did not match its exit status"))
			}
		})
	})
}
