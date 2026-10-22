
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
const git = (...a) => execFileSync("git", a, { cwd: "C:/work/Zoo-Code-fork/vps2-f6-wt", encoding: "utf8" }).trim();
const base = git("rev-parse", "2fe28542d");
const head = git("rev-parse", "254aabf31");
const mod = await import(pathToFileURL("C:/work/Zoo-Code-fork/vps2-f6-wt/scripts/stryker-diff.mjs").href);
const m = mod.selectFromGit("C:/work/Zoo-Code-fork/vps2-f6-wt", base, head);
for (const p of m.packages) {
  console.log("package", p.id);
  console.log(JSON.stringify(p, null, 1).slice(0, 1800));
}
