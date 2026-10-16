import assert from "node:assert/strict"
import fs from "node:fs"
import { URL } from "node:url"
import { describe, it } from "node:test"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
const workflow = fs.readFileSync(new URL("../.github/workflows/solheim-provider-smoke.yml", import.meta.url), "utf8")
const codeQa = fs.readFileSync(new URL("../.github/workflows/code-qa.yml", import.meta.url), "utf8")
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const driver = fs.readFileSync(new URL("./solheim-smoke/driver.mts", import.meta.url), "utf8")
const recorder = fs.readFileSync(new URL("./solheim-smoke/record.sh", import.meta.url), "utf8")
const smokePkg = JSON.parse(fs.readFileSync(new URL("./solheim-smoke/package.json", import.meta.url), "utf8"))

describe("Project A provider smoke workflow", () => {
	it("runs smoke TypeScript as ESM without requiring compiled workspace packages", () => {
		assert.equal(smokePkg.type, "module")
		assert.equal(smokePkg.private, true)
	})
	it("runs only by manual dispatch against the exact trusted main revision", () => {
		assert.match(workflow, /workflow_dispatch:/)
		assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/)
		assert.match(workflow, /ref: \$\{\{ github.sha \}\}/)
		assert.ok(!workflow.includes("pull_request_review:"))
		assert.ok(!workflow.includes("pull_request_target:"))
		assert.match(workflow, /persist-credentials: false/)
		assert.match(workflow, /environment: final-vscode-review-smoke/)
	})
	it("has one credential-bearing step, no GitHub write permissions, and no posting", () => {
		assert.equal((workflow.match(/secrets\./g) ?? []).length, 1)
		const before = workflow.slice(0, workflow.indexOf("- name: Run Solheim provider smoke"))
		assert.ok(!before.includes("secrets."))
		assert.match(workflow, /permissions:\n\s+contents: read/)
		assert.ok(!/\bwrite\b/.test(workflow))
		assert.ok(!workflow.includes("github-script"))
		assert.ok(!workflow.includes("post-review"))
	})
	it("has one smoke job and no review, routing, shadow, or deterministic lanes", () => {
		const jobs = workflow.split("jobs:\n")[1] ?? ""
		assert.deepEqual(
			[...jobs.matchAll(/^ {4}([a-z-]+):$/gm)].map((match) => match[1]),
			["smoke"],
		)
		for (const name of [
			"theme-review",
			"probe-dispatch",
			"rules-review",
			"merge-report",
			"bounded-code-review",
			"model-qualification",
		])
			assert.ok(!workflow.includes(name))
		assert.ok(!driver.includes("model-qualification"))
		assert.ok(!driver.includes("AcknowledgeCompletion"))
	})
	it("bounds runtime and serializes the single provider instance", () => {
		assert.match(workflow, /cancel-in-progress: false/)
		assert.match(workflow, /timeout-minutes: 8/)
		assert.match(workflow, /^ {8}timeout-minutes: 25$/m)
	})
	it("uploads only the verdict and video, never host logs or storage", () => {
		const paths = workflow.split("path: |\n")[1]?.split("                  if-no-files-found:")[0]
		assert.deepEqual(
			paths
				?.trim()
				.split("\n")
				.map((line) => line.trim()),
			[
				"${{ runner.temp }}/solheim-provider-smoke/verdict.json",
				"${{ runner.temp }}/solheim-provider-smoke/smoke.mp4",
			],
		)
		assert.match(workflow, /!cancelled\(\)/)
		assert.match(workflow, /if-no-files-found: error/)
		assert.ok(!driver.includes("console.error("))
		assert.ok(!driver.includes("stderrLog"))
	})
	it("records a fresh display with credential-free ffmpeg and bounded teardown", () => {
		assert.match(workflow, /install -y xvfb ffmpeg/)
		assert.match(workflow, /xvfb-run -a -s "-screen 0 1280x720x24 -nolisten tcp"/)
		assert.match(recorder, /env -i "PATH=\$PATH" "DISPLAY=\$DISPLAY"/)
		assert.match(recorder, /-t 480 -fs 125829120/)
		assert.match(recorder, /frag_keyframe\+empty_moov/)
		assert.match(recorder, /trap finish EXIT/)
		assert.match(recorder, /attempt < 50/)
		assert.ok(!recorder.includes("SOLHEIM_API_KEY"))
		assert.match(workflow, /retention-days: 7/)
	})
	it("keeps Code QA and package commands focused on smoke contracts", () => {
		for (const command of ["test:solheim-smoke:unit", "test:solheim-smoke-ci", "solheim-smoke:check-types"])
			assert.ok(codeQa.includes(command))
		assert.ok(!codeQa.includes("model-qualification"))
		assert.ok(!Object.keys(pkg.scripts).some((name) => name.includes("model-qualification")))
		assert.ok(!codeQa.includes("final-smoke"))
		assert.equal(pkg.scripts["solheim:smoke"], "node --import tsx scripts/solheim-smoke/driver.mts")
		assert.ok(!fs.existsSync(new URL("../.github/workflows/final-vscode-review-smoke.yml", import.meta.url)))
	})
})

// Runs record.sh with stub ffmpeg and ffprobe, so no display or codec is needed.
function runRecorder(args, { ffmpegWrites = true, ffprobeOk = true } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-sh-"))
	const bin = path.join(dir, "bin")
	fs.mkdirSync(bin)
	const stub = (name, body) =>
		fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
	// The stub ffmpeg writes the last argument, stops on INT, and exits.
	stub(
		"ffmpeg",
		`${ffmpegWrites ? 'for a; do :; done; echo data > "$a"' : ":"}\ntrap 'exit 0' INT\nwhile true; do sleep 0.05; done`,
	)
	stub("ffprobe", ffprobeOk ? "exit 0" : "exit 1")
	const result = spawnSync("bash", [new URL("./solheim-smoke/record.sh", import.meta.url).pathname, ...args], {
		env: { PATH: `${bin}:${process.env.PATH}`, DISPLAY: ":99", SOLHEIM_SMOKE_OUT_DIR: path.join(dir, "out") },
		encoding: "utf8",
		timeout: 20_000,
	})
	fs.rmSync(dir, { recursive: true, force: true })
	return result
}

describe("record.sh exit and validation behavior", () => {
	it("passes when the command succeeds and the recording is valid", () => {
		assert.equal(runRecorder(["true"]).status, 0)
	})
	it("keeps the exit code of a failing command", () => {
		assert.equal(runRecorder(["bash", "-c", "exit 7"]).status, 7)
	})
	it("fails when the recording is missing", () => {
		const result = runRecorder(["true"], { ffmpegWrites: false })
		assert.equal(result.status, 1)
		assert.match(result.stdout, /recording failed/)
	})
	it("fails when ffprobe rejects the recording", () => {
		assert.equal(runRecorder(["true"], { ffprobeOk: false }).status, 1)
	})
	it("keeps a failing command code when the recording is also invalid", () => {
		assert.equal(runRecorder(["bash", "-c", "exit 7"], { ffprobeOk: false }).status, 7)
	})
})
