// Scratch: run the mutation-gate preflight (line-count + directive validation)
// against the current F2' head. Usage: node .f4-preflight.cjs <base-sha>
const { execSync } = require("child_process")

async function main() {
	const wt = "C:/work/Zoo-Code-fork/vps2-f4-wt"
	const m = await import("file:///C:/work/Zoo-Code-fork/vps2-f4-wt/scripts/stryker-diff.mjs")
	const head = execSync("git -C " + wt + " rev-parse HEAD", { encoding: "utf8" }).trim()
	const base = process.argv[2]
	const r = m.selectFromGit(wt, base, head)
	console.log("HEAD:", head)
	console.log("BASE:", base)
	for (const p of r.packages) {
		console.log(`PACKAGE ${p.id}: ${p.changedExecutableLines} changed executable lines (limit ${m.MAX_CHANGED_LINES}), ${p.files.length} files`)
		for (const f of p.files) {
			console.log(`  ${f.path}: ${f.executableLines.length} lines`)
		}
	}
	console.log("PREFLIGHT OK")
}

main().catch((e) => {
	console.error("FAIL:", e.message)
	process.exit(1)
})
