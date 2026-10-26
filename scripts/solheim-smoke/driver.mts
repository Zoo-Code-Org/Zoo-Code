import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHostRuntime } from "../agent-evals/launcher.ts"
import { runSmoke, smokeExitCode } from "./run.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const out = process.env.SOLHEIM_SMOKE_OUT_DIR
if (!out) throw new Error("Set SOLHEIM_SMOKE_OUT_DIR to a scratch directory")
await fs.mkdir(out, { recursive: true })
const runtime = createHostRuntime({ root, artifactsDir: out })
try {
	const verdict = await runSmoke(runtime, process.env.SOLHEIM_API_KEY ?? "")
	console.log(`Solheim provider smoke: ${verdict.code}`)
	process.exit(smokeExitCode(verdict))
} catch {
	console.log("Solheim provider smoke: SETUP_FAILED")
	process.exit(1)
}
