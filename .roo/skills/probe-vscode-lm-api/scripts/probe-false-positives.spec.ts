import fs from "fs"
import path from "path"

import { extractLeakedToolCalls } from "../vscode-lm"

// Point this at the probe's OUT_DIR. Scratch harness: not a committed test.
const TRANSCRIPTS = process.env.LM_PROBE_TRANSCRIPTS ?? path.resolve(__dirname, "../../../../.tmp/transcripts")

describe("probe: false-positive check against real transcripts", () => {
	it("reports which transcripts extractLeakedToolCalls would treat as real calls", () => {
		const names = new Set(["read_file"])
		const report: string[] = []
		for (const file of fs.readdirSync(TRANSCRIPTS).filter((name) => name.endsWith(".txt"))) {
			const text = fs.readFileSync(path.join(TRANSCRIPTS, file), "utf8")
			if (!/<(?:antml:)?invoke/i.test(text)) {
				continue
			}
			const { calls } = extractLeakedToolCalls(text, names)
			report.push(`${calls.length > 0 ? "RECOVERED" : "passthrough"}\t${file}\t${JSON.stringify(calls)}`)
		}
		fs.writeFileSync(path.join(TRANSCRIPTS, "..", "false-positive-report.txt"), report.join("\n"))
		console.log(report.join("\n"))
	})
})
