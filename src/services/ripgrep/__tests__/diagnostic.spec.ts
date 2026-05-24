// npx vitest run src/services/ripgrep/__tests__/diagnostic.spec.ts

import * as path from "path"

import { vi, describe, it, expect, beforeEach } from "vitest"

import { getRipgrepDiagnostic } from "../diagnostic"

const ripgrepMock = vi.hoisted(() => ({
	value: undefined as { rgPath?: string } | undefined,
}))

const fsMock = vi.hoisted(() => ({
	existing: new Set<string>(),
}))

vi.mock("../internal/loadRipgrep", () => ({
	loadRipgrep: () => ripgrepMock.value,
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: (p: string) => Promise.resolve(fsMock.existing.has(p)),
}))

const APP_ROOT = "/app"

const binName = process.platform.startsWith("win") ? "rg.exe" : "rg"
const universalRelBin = `bin/${process.platform}-${process.arch}/${binName}`

const expectedCandidates = [
	path.join(APP_ROOT, "node_modules", "@vscode", "ripgrep", "bin", binName),
	path.join(APP_ROOT, "node_modules", "vscode-ripgrep", "bin", binName),
	path.join(APP_ROOT, "node_modules.asar.unpacked", "vscode-ripgrep", "bin", binName),
	path.join(APP_ROOT, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", binName),
	path.join(APP_ROOT, "node_modules", "@vscode", "ripgrep-universal", ...universalRelBin.split("/")),
	path.join(APP_ROOT, "node_modules.asar.unpacked", "@vscode", "ripgrep-universal", ...universalRelBin.split("/")),
]

describe("getRipgrepDiagnostic", () => {
	beforeEach(() => {
		ripgrepMock.value = undefined
		fsMock.existing = new Set<string>()
	})

	it("includes rgPath and fileExistsAtPath: true when loadRipgrep returns an existing path", async () => {
		const rgPath = "/some/path"
		ripgrepMock.value = { rgPath }
		fsMock.existing = new Set([rgPath])

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain("rgPath: /some/path")
		expect(report).toContain("fileExistsAtPath: true")
		expect(report).toContain("after .asar→.asar.unpacked: /some/path")
	})

	it("rewrites node_modules.asar to node_modules.asar.unpacked in the report", async () => {
		const rgPath = "/app/node_modules.asar/foo/rg"
		const substituted = "/app/node_modules.asar.unpacked/foo/rg"
		ripgrepMock.value = { rgPath }
		fsMock.existing = new Set([substituted])

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain(`after .asar→.asar.unpacked: ${substituted}`)
		expect(report).toContain("fileExistsAtPath: true")
	})

	it("reports require failure when loadRipgrep returns undefined", async () => {
		ripgrepMock.value = undefined

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain("loadRipgrep() returned undefined (require threw)")
	})

	it("reports rgPath: (undefined) when loadRipgrep returns an object without rgPath", async () => {
		ripgrepMock.value = {}

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain("rgPath: (undefined)")
		expect(report).not.toContain("after .asar→.asar.unpacked:")
	})

	it("marks only the first probe candidate as found when only it exists", async () => {
		fsMock.existing = new Set([expectedCandidates[0]])

		const report = await getRipgrepDiagnostic(APP_ROOT)

		const found = expectedCandidates.filter((c) => report.includes(`✓ ${c}`))
		const missing = expectedCandidates.filter((c) => report.includes(`✗ ${c}`))

		expect(found).toEqual([expectedCandidates[0]])
		expect(missing).toEqual(expectedCandidates.slice(1))
	})

	it("marks all probe candidates as missing when none exist", async () => {
		fsMock.existing = new Set<string>()

		const report = await getRipgrepDiagnostic(APP_ROOT)

		for (const candidate of expectedCandidates) {
			expect(report).toContain(`✗ ${candidate}`)
		}
		expect(report).not.toContain("✓ ")
	})
})
