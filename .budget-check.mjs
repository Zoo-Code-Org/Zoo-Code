import { selectFromGit } from "C:/work/Zoo-Code-fork/Zoo-Code/scripts/stryker-diff.mjs"
import { execFileSync } from "node:child_process"

const ROOT = "C:/work/Zoo-Code-fork/vps2-f7-wt"
const full = (ref) => execFileSync("git", ["rev-parse", ref], { cwd: ROOT, encoding: "utf8" }).trim()

const order = [
	["f1a", "origin/main", "origin/vps2/f1a-view-identity"],
	["f1b", "origin/vps2/f1a-view-identity", "origin/vps2/f1b-getstate-merge"],
	["f1c", "origin/vps2/f1b-getstate-merge", "origin/vps2/f1c-webview-identity"],
	["f2", "origin/vps2/f1c-webview-identity", "origin/vps2/f2-durable-viewstates"],
	["f3", "origin/vps2/f2-durable-viewstates", "origin/vps2/f3-mode-profile-writes"],
	["f4", "origin/vps2/f3-mode-profile-writes", "origin/vps2/f4-cross-instance-reset"],
	["f5", "origin/vps2/f4-cross-instance-reset", "origin/vps2/f5-api-wiring"],
	["f6", "origin/vps2/f5-api-wiring", "origin/vps2/f6-e2e-viewstate"],
	["f7", "origin/vps2/f6-e2e-viewstate", "origin/vps2/f7-viewstate-loaded"],
]

for (const [label, baseRef, headRef] of order) {
	const base = full(baseRef)
	const head = full(headRef)
	const r = selectFromGit(ROOT, base, head)
	const lines = r.packages.map((p) => `${p.id}=${p.changedExecutableLines}`).join(" ")
	console.log(`${label}: mergeBase=${r.mergeBase.slice(0, 12)} ${lines || "(no executable files)"}`)
}
