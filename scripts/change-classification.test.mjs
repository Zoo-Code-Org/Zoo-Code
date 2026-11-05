import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const classifierPath = path.join(repositoryRoot, "scripts/change-classification.mjs")

import {
	allowlistFingerprint,
	classifyEntries,
	classifyEvent,
	formatSummary,
	isDocsOnlyPath,
	parseNameStatus,
	runHistory,
} from "./change-classification.mjs"

describe("documentation-only allowlist", () => {
	it("accepts the enumerated root documentation files", () => {
		for (const filePath of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "PRIVACY.md", "CODE_OF_CONDUCT.md"]) {
			assert.ok(isDocsOnlyPath(filePath), `${filePath} should be allowlisted`)
		}
	})

	it("accepts markdown under the documentation and template prefixes", () => {
		for (const filePath of [
			"docs/development-quality-checks.md",
			"docs/architecture/task-lifecycle-model.md",
			".github/pull_request_template.md",
			".github/ISSUE_TEMPLATE/bug_report.md",
		]) {
			assert.ok(isDocsOnlyPath(filePath), `${filePath} should be allowlisted`)
		}
	})

	it("rejects files that are build, runtime, test, or release inputs", () => {
		for (const filePath of [
			"CHANGELOG.md",
			"src/CHANGELOG.md",
			"AGENTS.md",
			"src/README.md",
			"locales/en/README.md",
			"package.json",
			"pnpm-lock.yaml",
			"docs/image.png",
			"docs/scripts/example.js",
			".github/workflows/code-qa.yml",
			".github/CODEOWNERS",
			".github/actions/classify-changes/action.yml",
			"src/core/task/index.ts",
		]) {
			assert.equal(isDocsOnlyPath(filePath), false, `${filePath} must not be allowlisted`)
		}
	})

	it("never skips protected path segments even under allowlisted prefixes", () => {
		for (const filePath of [
			"docs/fixtures/sample.md",
			"docs/__tests__/case.md",
			"docs/generated/report.md",
			"docs/examples/walkthrough.md",
			"docs/test-utils/guide.md",
			".github/ISSUE_TEMPLATE/fixtures/template.md",
		]) {
			assert.equal(isDocsOnlyPath(filePath), false, `${filePath} must not be allowlisted`)
		}
	})

	it("rejects traversal, absolute paths, and empty values", () => {
		for (const filePath of ["../outside.md", "/etc/passwd.md", "", undefined, null]) {
			assert.equal(isDocsOnlyPath(filePath), false)
		}
	})
})

describe("name-status parsing", () => {
	it("parses single-path entries", () => {
		assert.deepEqual(parseNameStatus("A\0docs/new.md\0M\0README.md\0D\0src/gone.ts\0"), [
			{ status: "A", path: "docs/new.md" },
			{ status: "M", path: "README.md" },
			{ status: "D", path: "src/gone.ts" },
		])
	})

	it("parses rename entries with old and new paths", () => {
		assert.deepEqual(parseNameStatus("R100\0docs/old.md\0docs/new.md\0M\0src/a.ts\0"), [
			{ status: "R", oldPath: "docs/old.md", path: "docs/new.md" },
			{ status: "M", path: "src/a.ts" },
		])
	})

	it("rejects malformed entries", () => {
		assert.throws(() => parseNameStatus("R100\0only-one-path\0"))
		assert.throws(() => parseNameStatus("M\0"))
	})
})

describe("change classification", () => {
	it("fails safe on an empty change range", () => {
		const result = classifyEntries([])
		assert.equal(result.category, "full")
		assert.equal(result.reasonCode, "empty-change-range")
	})

	it("classifies an all-documentation range including deletions and renames", () => {
		const result = classifyEntries([
			{ status: "A", path: "docs/new.md" },
			{ status: "M", path: "README.md" },
			{ status: "D", path: "docs/gone.md" },
			{ status: "R", oldPath: "docs/old.md", path: "docs/renamed.md" },
			{ status: "T", path: "docs/symlinked.md" },
		])
		assert.equal(result.category, "docs-only")
		assert.equal(result.changedFiles, 5)
	})

	it("fails safe when a rename moves documentation into source", () => {
		const result = classifyEntries([{ status: "R", oldPath: "docs/old.md", path: "src/moved.md" }])
		assert.equal(result.category, "full")
		assert.equal(result.reasonCode, "non-documentation-path")
		assert.ok(result.offendingPaths.includes("src/moved.md"))
	})

	it("fails safe when a rename moves source into documentation", () => {
		const result = classifyEntries([{ status: "R", oldPath: "src/moved.ts", path: "docs/moved.md" }])
		assert.equal(result.category, "full")
		assert.equal(result.reasonCode, "non-documentation-path")
		assert.ok(result.offendingPaths.includes("src/moved.ts"))
	})

	it("fails safe on mixed documentation and source changes", () => {
		const result = classifyEntries([
			{ status: "M", path: "README.md" },
			{ status: "M", path: "src/core/task/index.ts" },
		])
		assert.equal(result.category, "full")
		assert.equal(result.reasonCode, "non-documentation-path")
	})

	it("fails safe on protected segments inside the documentation tree", () => {
		const result = classifyEntries([{ status: "R", oldPath: "docs/a.md", path: "docs/fixtures/b.md" }])
		assert.equal(result.category, "full")
		assert.equal(result.reasonCode, "protected-path-segment")
	})

	it("fails safe on unrecognized change statuses", () => {
		const result = classifyEntries([{ status: "C", oldPath: "docs/a.md", path: "docs/b.md" }])
		assert.equal(result.category, "full")
		assert.equal(result.reasonCode, "unrecognized-status")
	})
})

describe("event gating", () => {
	const docsEntries = [{ status: "M", path: "docs/only.md" }]

	it("allows a skip only for documentation-only pull request ranges", () => {
		assert.equal(classifyEvent({ eventName: "pull_request", entries: docsEntries }).category, "docs-only")
	})

	it("forces full validation for merge queue, push, and scheduled events", () => {
		for (const eventName of ["merge_group", "push", "schedule", "workflow_dispatch"]) {
			const result = classifyEvent({ eventName, entries: docsEntries })
			assert.equal(result.category, "full")
			assert.equal(result.reasonCode, "non-pr-event")
		}
	})

	it("honors explicit full-validation overrides", () => {
		const label = classifyEvent({
			eventName: "pull_request",
			entries: docsEntries,
			forceFullReasonCode: "override-label",
		})
		assert.equal(label.category, "full")
		assert.equal(label.reasonCode, "override-label")

		const variable = classifyEvent({
			eventName: "pull_request",
			entries: docsEntries,
			forceFullReasonCode: "override-variable",
		})
		assert.equal(variable.reasonCode, "override-variable")
	})

	it("ignores unknown override codes instead of failing open", () => {
		const result = classifyEvent({ eventName: "pull_request", entries: docsEntries, forceFullReasonCode: "bogus" })
		assert.equal(result.category, "docs-only")
	})
})

describe("summary rendering", () => {
	it("records the category, reason, and allowlist fingerprint", () => {
		const summary = formatSummary(classifyEntries([{ status: "M", path: "docs/only.md" }]), {
			eventName: "pull_request",
		})
		assert.match(summary, /docs-only/)
		assert.match(summary, /Change-based validation classification/)
		assert.ok(summary.includes(allowlistFingerprint()))
	})
})

function git(tempRepo, args) {
	return execFileSync("git", ["-c", "user.email=ci@example.com", "-c", "user.name=CI Test", ...args], {
		cwd: tempRepo,
		encoding: "utf8",
	})
}

function createTempRepository() {
	const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "change-classification-"))
	git(tempRepo, ["init", "--initial-branch=main"])
	fs.writeFileSync(path.join(tempRepo, "src-code.ts"), "export const base = 1\n")
	fs.mkdirSync(path.join(tempRepo, "docs"), { recursive: true })
	fs.writeFileSync(path.join(tempRepo, "docs/base.md"), "# base\n")
	git(tempRepo, ["add", "."])
	git(tempRepo, ["commit", "-m", "base"])
	return tempRepo
}

describe("history validation", () => {
	it("classifies representative commits without errors", () => {
		const tempRepo = createTempRepository()
		try {
			fs.writeFileSync(path.join(tempRepo, "docs/guide.md"), "# guide\n")
			git(tempRepo, ["add", "."])
			git(tempRepo, ["commit", "-m", "docs: add guide (#101)"])

			fs.writeFileSync(path.join(tempRepo, "src-code.ts"), "export const base = 2\n")
			git(tempRepo, ["add", "."])
			git(tempRepo, ["commit", "-m", "feat: change code (#102)"])

			fs.writeFileSync(path.join(tempRepo, "docs/mixed.md"), "# mixed\n")
			fs.writeFileSync(path.join(tempRepo, "src-code.ts"), "export const base = 3\n")
			git(tempRepo, ["add", "."])
			git(tempRepo, ["commit", "-m", "mixed: docs and code (#103)"])

			const rows = runHistory(tempRepo, { limit: 10 })
			const bySubject = new Map(rows.map((row) => [row.subject, row]))
			assert.equal(bySubject.get("docs: add guide (#101)").category, "docs-only")
			assert.equal(bySubject.get("feat: change code (#102)").category, "full")
			assert.equal(bySubject.get("mixed: docs and code (#103)").category, "full")
		} finally {
			fs.rmSync(tempRepo, { recursive: true, force: true })
		}
	})
})

describe("ci command", () => {
	function runCi(tempRepo, args) {
		const githubOutput = path.join(tempRepo, "github-output.env")
		const stepSummary = path.join(tempRepo, "step-summary.md")
		const result = spawnSync(process.execPath, [classifierPath, "ci", ...args], {
			cwd: repositoryRoot,
			encoding: "utf8",
			env: {
				...process.env,
				GITHUB_OUTPUT: githubOutput,
				GITHUB_STEP_SUMMARY: stepSummary,
			},
		})
		return { result, githubOutput, stepSummary }
	}

	function readOutputEnv(filePath) {
		const entries = new Map()
		for (const line of fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean)) {
			const index = line.indexOf("=")
			entries.set(line.slice(0, index), line.slice(index + 1))
		}
		return entries
	}

	it("classifies a documentation-only merge commit and emits workflow outputs", () => {
		const tempRepo = createTempRepository()
		try {
			git(tempRepo, ["checkout", "-b", "docs-change"])
			fs.writeFileSync(path.join(tempRepo, "docs/pr.md"), "# pr\n")
			git(tempRepo, ["add", "."])
			git(tempRepo, ["commit", "-m", "docs change"])
			git(tempRepo, ["checkout", "main"])
			git(tempRepo, ["merge", "--no-ff", "-m", "merge docs change", "docs-change"])
			const headSha = git(tempRepo, ["rev-parse", "HEAD"]).trim()

			const { result, githubOutput, stepSummary } = runCi(tempRepo, [
				"--event",
				"pull_request",
				"--head",
				headSha,
				"--repo-root",
				tempRepo,
			])
			assert.equal(result.status, 0, result.stderr)
			const outputs = readOutputEnv(githubOutput)
			assert.equal(outputs.get("category"), "docs-only")
			assert.equal(outputs.get("changed-files"), "1")
			const summary = fs.readFileSync(stepSummary, "utf8")
			assert.match(summary, /docs-only/)
			assert.ok(summary.includes("docs/pr.md"))
		} finally {
			fs.rmSync(tempRepo, { recursive: true, force: true })
		}
	})

	it("forces full validation for non-pull_request events", () => {
		const tempRepo = createTempRepository()
		try {
			git(tempRepo, ["checkout", "-b", "docs-change"])
			fs.writeFileSync(path.join(tempRepo, "docs/pr.md"), "# pr\n")
			git(tempRepo, ["add", "."])
			git(tempRepo, ["commit", "-m", "docs change"])
			git(tempRepo, ["checkout", "main"])
			git(tempRepo, ["merge", "--no-ff", "-m", "merge docs change", "docs-change"])
			const headSha = git(tempRepo, ["rev-parse", "HEAD"]).trim()

			const { result, githubOutput } = runCi(tempRepo, [
				"--event",
				"merge_group",
				"--head",
				headSha,
				"--repo-root",
				tempRepo,
			])
			assert.equal(result.status, 0, result.stderr)
			assert.equal(readOutputEnv(githubOutput).get("reason-code"), "non-pr-event")
		} finally {
			fs.rmSync(tempRepo, { recursive: true, force: true })
		}
	})

	it("fails closed when the head commit is missing from history", () => {
		const tempRepo = createTempRepository()
		try {
			const { result } = runCi(tempRepo, [
				"--event",
				"pull_request",
				"--head",
				"0".repeat(40),
				"--repo-root",
				tempRepo,
			])
			assert.equal(result.status, 1)
			assert.match(result.stderr, /::error/)
		} finally {
			fs.rmSync(tempRepo, { recursive: true, force: true })
		}
	})
})
