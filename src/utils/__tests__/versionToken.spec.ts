import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { BigIntStats } from "fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { computeVersionToken, versionTokenOfStat } from "../versionToken"

// BigIntStats is a class-backed interface without a public constructor, so a
// plain-object test double is the only practical way to pin the token format
// without real files. Last-resort double assertion (test-local, per AGENTS.md).
function makeStats(overrides: Partial<BigIntStats> = {}): BigIntStats {
	// This repo's @types/node models every StatsBase field (including the *Ms
	// fields) as the parameter type T, so all values here are bigint literals;
	// the token only reads the *Ns fields. Single-step downcast from Partial to
	// the full type (BigIntStats has no public constructor).
	const base: Partial<BigIntStats> = {
		dev: 7n,
		ino: 4242n,
		size: 1234n,
		atimeMs: 1_700_000_000_000n,
		mtimeMs: 1_700_000_000_123n,
		ctimeMs: 1_700_000_000_789n,
		birthtimeMs: 1_700_000_000_000n,
		atimeNs: 1_700_000_000_000_000_000n,
		mtimeNs: 1_700_000_000_123_456_789n,
		ctimeNs: 1_700_000_000_789_999_999n,
		birthtimeNs: 1_700_000_000_000_000_000n,
	}
	return { ...base, ...overrides } as BigIntStats
}

describe("versionTokenOfStat (A1, epic #1375)", () => {
	it("is deterministic for an identical stat", () => {
		expect(versionTokenOfStat(makeStats())).toBe(versionTokenOfStat(makeStats()))
	})

	it("matches the documented dev:ino:size:mtimeNs:ctimeNs format with exact decimal fields", () => {
		expect(versionTokenOfStat(makeStats())).toBe("7:4242:1234:1700000000123456789:1700000000789999999")
	})

	it("distinguishes size changes at identical timestamps", () => {
		expect(versionTokenOfStat(makeStats({ size: 1235n }))).not.toBe(versionTokenOfStat(makeStats()))
	})

	it("distinguishes a one-nanosecond mtime change", () => {
		expect(versionTokenOfStat(makeStats({ mtimeNs: 1_700_000_000_123_456_790n }))).not.toBe(
			versionTokenOfStat(makeStats()),
		)
	})

	it("distinguishes a replaced file (dev/ino change) with identical content state", () => {
		const replaced = makeStats({ dev: 8n, ino: 999n })
		expect(versionTokenOfStat(replaced)).not.toBe(versionTokenOfStat(makeStats()))
	})

	it("renders nanosecond resolution exactly (no float quantization)", () => {
		const base = versionTokenOfStat(makeStats())
		const plusOneMicrosecond = versionTokenOfStat(makeStats({ mtimeNs: 1_700_000_000_123_457_789n }))
		// 1_000 ns apart — the BigInt derivation must keep the delta exact.
		const baseNs = BigInt(base.split(":")[3])
		const microNs = BigInt(plusOneMicrosecond.split(":")[3])
		expect(microNs - baseNs).toBe(1_000n)
	})

	it("handles sizes beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
		const size = 10_000_000_000_000_001n // 10^16 + 1 > 2^53
		const token = versionTokenOfStat(makeStats({ size }))
		expect(token).toBe(`7:4242:${size}:1700000000123456789:1700000000789999999`)
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

	it("derives the token from the on-disk state (single bigint stat)", async () => {
		const token = await computeVersionToken(file)
		expect(token).toBe(versionTokenOfStat(await fs.stat(file, { bigint: true })))
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
