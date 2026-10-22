const m = require("node:module")
async function main() {
	const wt = "C:/work/Zoo-Code-fork/vps2-f4-wt"
	const mod = await import("file:///C:/work/Zoo-Code-fork/vps2-f1-wt/scripts/stryker-diff.mjs")
	const base = process.argv[2]
	const head = process.argv[3]
	const r = mod.selectFromGit(wt, base, head)
	for (const p of r.packages) {
		console.log(p.id, p.changedExecutableLines, "lines,", p.files.length, "files")
	}
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1) })
