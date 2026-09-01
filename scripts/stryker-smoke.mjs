#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixtureRoot = path.join(repoRoot, "scripts/fixtures/stryker-smoke")
const reportDirectory = path.join(repoRoot, "reports/mutation/smoke")
const reportPath = path.join(reportDirectory, "mutation.json")

fs.rmSync(reportDirectory, { recursive: true, force: true })

const result = spawnSync(
	path.join(repoRoot, "node_modules/.bin/stryker"),
	["run", path.join(repoRoot, "stryker.config.mjs"), "--force", "--mutate", "smoke.ts"],
	{
		cwd: fixtureRoot,
		encoding: "utf8",
		timeout: 2 * 60 * 1_000,
		maxBuffer: 10 * 1024 * 1024,
		env: {
			...process.env,
			STRYKER_VITEST_CONFIG: "vitest.config.ts",
			STRYKER_VITEST_RELATED: "true",
			STRYKER_TEST_FILES: "[]",
			STRYKER_REPORT_DIR: reportDirectory,
		},
	},
)

if (result.error?.code === "ETIMEDOUT") {
	throw new Error("Stryker integration smoke exceeded two minutes")
}
if (result.status !== 0) {
	throw new Error(`Stryker integration smoke failed:\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}`)
}
if (!fs.existsSync(reportPath)) {
	throw new Error("Stryker integration smoke did not write mutation.json")
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"))
const mutants = Object.values(report.files ?? {}).flatMap((file) => file.mutants ?? [])
const killedComparison = mutants.find(
	(mutant) =>
		mutant.mutatorName === "EqualityOperator" && mutant.replacement.includes(">=") && mutant.status === "Killed",
)
const survivingLabel = mutants.find(
	(mutant) => mutant.mutatorName === "StringLiteral" && mutant.replacement === '""' && mutant.status === "Survived",
)
const uncovered = mutants.filter((mutant) => mutant.status === "NoCoverage")

if (!killedComparison) {
	throw new Error("Stryker smoke report did not contain the expected killed EqualityOperator mutant")
}
if (!survivingLabel) {
	throw new Error("Stryker smoke report did not contain the expected surviving StringLiteral mutant")
}
if (uncovered.length > 0) {
	throw new Error(`Stryker smoke report unexpectedly contained ${uncovered.length} uncovered mutant(s)`)
}

console.log(
	`Stryker smoke passed: ${mutants.length} mutants; expected EqualityOperator killed, StringLiteral survived, 0 uncovered.`,
)
