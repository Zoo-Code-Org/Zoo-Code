import { spawnSync } from "node:child_process"
import fs from "node:fs"

const data = JSON.parse(fs.readFileSync(new URL("./runner-data.json", import.meta.url), "utf8"))
fs.writeFileSync(new URL("./package-args.json", import.meta.url), JSON.stringify(process.argv.slice(2)))
const result = spawnSync(process.execPath, [data.vitest, "run", "--config", "vitest.config.mjs"], {
	stdio: "inherit",
	env: process.env,
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
