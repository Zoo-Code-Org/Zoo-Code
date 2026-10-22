
const { execSync } = require("child_process")
async function main() {
	const wt = "C:/work/Zoo-Code-fork/vps2-f3-wt"
	const m = await import("file:///C:/work/Zoo-Code-fork/vps2-f3-wt/scripts/stryker-diff.mjs")
	const head = execSync("git -C " + wt + " rev-parse HEAD", { encoding: "utf8" }).trim()
	const r = m.selectFromGit(wt, "a3e31e14b56a6d0285434b6ddd48f52dfaaa8100", head)
	for (const p of r.packages) {
		console.log("PACKAGE " + p.id + ": " + p.changedExecutableLines + "/" + m.MAX_CHANGED_LINES)
		for (const f of p.files) console.log("  " + f.path + ": " + f.executableLines.length)
	}
}
main()
