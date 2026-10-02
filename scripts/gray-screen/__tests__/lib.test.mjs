import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
	integerFlag,
	parseFlagArgs,
	resolveBuildDir,
	resolveServedFile,
	validateRelativeDir,
	writeTaskAtomically,
} from "../lib.mjs"

let tmp

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gray-screen-test-"))
})

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true })
})

describe("parseFlagArgs / integerFlag", () => {
	it("parses flag/value pairs", () => {
		assert.deepEqual(parseFlagArgs(["--messages", "10", "--two-byte", "true"]), { messages: "10", "two-byte": "true" })
	})

	it("rejects a flag with a missing operand", () => {
		assert.throws(() => parseFlagArgs(["--messages", "--text-bytes", "5"]), /Missing value for --messages/)
		assert.throws(() => parseFlagArgs(["--messages"]), /Missing value for --messages/)
	})

	it("accepts integers at or above the minimum and rejects everything else", () => {
		assert.equal(integerFlag("messages", "5000", 1), 5000)
		assert.equal(integerFlag("image-every", "0", 0), 0)
		for (const bad of ["0", "-3", "1.5", "abc", "", "NaN"]) {
			assert.throws(() => integerFlag("messages", bad, 1), /--messages must be an integer >= 1/)
		}
	})
})

describe("validateRelativeDir", () => {
	it("accepts plain relative paths", () => {
		for (const ok of [".mock-session", "a", "src/mock_1", "a.b/c-d"]) assert.equal(validateRelativeDir(ok), ok)
	})

	it("rejects shell metacharacters, absolute paths, traversal, dot and option-like segments", () => {
		const bad = ['safe"; touch /tmp/pwned; #', "a b", "$(id)", "/abs", "../x", "a/../b", ".", "a/./b", "-rf", "a/-rf", "", "a//b"]
		for (const dir of bad) assert.throws(() => validateRelativeDir(dir), /Invalid --dir/, JSON.stringify(dir))
	})
})

describe("resolveBuildDir", () => {
	it("maps the documented modes to fixed directories under the temp root", () => {
		assert.equal(resolveBuildDir("production", tmp), path.join(tmp, "zoo-webview-stress-build"))
		assert.equal(resolveBuildDir("development", tmp), path.join(tmp, "zoo-webview-stress-build-development"))
	})

	it("rejects any other mode, including path traversal", () => {
		for (const mode of ["../../../tmp/victim", "staging", "", "production/../x"]) {
			assert.throws(() => resolveBuildDir(mode, tmp), /Invalid --build-mode/, mode)
		}
	})

	it("refuses an output path that is a symlink", () => {
		fs.mkdirSync(path.join(tmp, "elsewhere"))
		fs.symlinkSync(path.join(tmp, "elsewhere"), path.join(tmp, "zoo-webview-stress-build"))

		assert.throws(() => resolveBuildDir("production", tmp), /symlink/)
	})
})

describe("resolveServedFile", () => {
	beforeEach(() => {
		fs.mkdirSync(path.join(tmp, "build", "assets"), { recursive: true })
		fs.mkdirSync(path.join(tmp, "build-secret"))
		fs.writeFileSync(path.join(tmp, "build", "index.html"), "index")
		fs.writeFileSync(path.join(tmp, "build", "assets", "app.js"), "js")
		fs.writeFileSync(path.join(tmp, "build-secret", "credentials.json"), "secret")
		fs.symlinkSync(path.join(tmp, "build-secret"), path.join(tmp, "build", "link"))
	})

	const root = () => path.join(tmp, "build")

	it("serves files inside the build directory, with / mapping to index.html", () => {
		assert.equal(resolveServedFile(root(), "/"), fs.realpathSync(path.join(root(), "index.html")))
		assert.equal(resolveServedFile(root(), "/assets/app.js"), fs.realpathSync(path.join(root(), "assets", "app.js")))
	})

	it("returns undefined for traversal (plain, encoded and sibling-prefix), symlink escapes, directories and bad input", () => {
		for (const p of [
			"/../build-secret/credentials.json",
			"/%2e%2e%2fbuild-secret%2fcredentials.json",
			"/link/credentials.json",
			"/assets",
			"/missing.js",
			"/%E0%A4%A",
			"/a\0b",
		]) {
			assert.equal(resolveServedFile(root(), p), undefined, p)
		}
	})

	it("returns undefined when the build directory does not exist", () => {
		assert.equal(resolveServedFile(path.join(tmp, "nope"), "/"), undefined)
	})
})

describe("writeTaskAtomically", () => {
	it("writes every file into tasks/<id> and leaves no staging directory", () => {
		const taskDir = writeTaskAtomically(tmp, "t1", { "a.json": { a: 1 }, "b.json": [2] })

		assert.equal(taskDir, path.join(tmp, "tasks", "t1"))
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(taskDir, "a.json"), "utf8")), { a: 1 })
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(taskDir, "b.json"), "utf8")), [2])
		assert.deepEqual(fs.readdirSync(tmp).sort(), ["tasks"])
	})

	it("leaves neither a task directory nor staging files when a write fails", () => {
		const circular = {}
		circular.self = circular

		assert.throws(() => writeTaskAtomically(tmp, "t2", { "ok.json": { ok: true }, "bad.json": circular }), /circular/i)

		assert.equal(fs.existsSync(path.join(tmp, "tasks", "t2")), false)
		assert.deepEqual(fs.readdirSync(tmp), [])
	})
})
