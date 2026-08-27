import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { Stats } from "fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { computeVersionToken, versionTokenOfStat } from "../versionToken"

// Stats is a class-backed interface without a public constructor, so a plain-object
// test double is the only practical way to pin the token format without real files.
// Last-resort double assertion (test-local, per AGENTS.md).
function makeStats(overrides: Partial<Stats> = {}): Stats {
	const base: Partial<Stats> = {
		dev: 7,
		ino: 4242,
		size: 1234,
		atimeMs: 1_700_000_000_000,
		mtimeMs: 1_700_000_000_123.456,
		ctimeMs: 1_700_000_000_789.999,
		birthtimeMs: 1_700_000_000_000,
	}
	return { ...base, ...overrides } as unknown as Stats
}

describe("versionTokenOfStat (A1, epic #1375)", () => {
	it("is deterministic for an identical stat", () => {
		expect(versionTokenOfStat(makeStats())).toBe(versionTokenOfStat(makeStats()))
	})

	it("matches the documented dev:ino:size:mtimeNs:ctimeNs format", () => {
		const expected = [
			"7",
			"4242",
			"1234",
			Math.round(1_700_000_000_123.456 * 1e6).toString(),
			Math.round(1_700_000_000_789.999 * 1e6).toString(),
		].join(":")
		expect(versionTokenOfStat(makeStats())).toBe(expected)
	})

	it("distinguishes size changes at identical timestamps", () => {
		expect(versionTokenOfStat(makeStats({ size: 1235 }))).not.toBe(versionTokenOfStat(makeStats()))
	})

	it("distinguishes mtime changes at identical size", () => {
		expect(versionTokenOfStat(makeStats({ mtimeMs: 1_700_000_000_124 }))).not.toBe(versionTokenOfStat(makeStats()))
	})

	it("distinguishes a replaced file (dev/ino change) with identical content state", () => {
		const replaced = makeStats({ dev: 8, ino: 999 })
		expect(versionTokenOfStat(replaced)).not.toBe(versionTokenOfStat(makeStats()))
	})

	it("preserves sub-ms mtime resolution in the ns field", () => {
		const wholeMs = versionTokenOfStat(makeStats({ mtimeMs: 1_700_000_000_123 }))
		const halfMsLater = versionTokenOfStat(makeStats({ mtimeMs: 1_700_000_000_123.5 }))
		expect(halfMsLater).not.toBe(wholeMs)
		// 0.5 ms = 500_000 ns. The float-derived ns field is quantized (~256 ns at
		// this epoch), so allow a bounded drift instead of asserting an exact value.
		const diff = Number(halfMsLater.split(":")[3]) - Number(wholeMs.split(":")[3])
		expect(Math.abs(diff - 500_000)).toBeLessThanOrEqual(512)
	})

	it("handles sizes beyond 32 bits without precision loss", () => {
		const size = 5_000_000_000 // > 2^32
		const token = versionTokenOfStat(makeStats({ size }))
		expect(token).toContain(`:4242:${size}:`)
	})
})

describe("computeVersionToken (A1, epic #1375)", () => {
	let tmpDir: string
	let file: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "version-token-"))
		file = path.join(tmpDir, "seed.txt")
		await fs.writeFile(file, "seed content", "utf8")
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("derives the token from the on-disk state (single stat)", async () => {
		const token = await computeVersionToken(file)
		expect(token).toBe(versionTokenOfStat(await fs.stat(file)))
	})

	it("changes when the file content changes", async () => {
		const before = await computeVersionToken(file)
		// Different size + a new mtime — both must move the token.
		await fs.writeFile(file, "seed content, extended", "utf8")
		await new Promise((resolve) => setTimeout(resolve, 5))
		expect(await computeVersionToken(file)).not.toBe(before)
	})

	it("rejects with ENOENT for an absent file", async () => {
		await expect(computeVersionToken(path.join(tmpDir, "absent.txt"))).rejects.toMatchObject({
			code: "ENOENT",
		})
	})
})
