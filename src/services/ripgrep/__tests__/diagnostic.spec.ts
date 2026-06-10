// npx vitest run src/services/ripgrep/__tests__/diagnostic.spec.ts

import * as path from "path"
import { EventEmitter } from "events"

import { vi, describe, it, expect, beforeEach } from "vitest"
import * as vscode from "vscode"
import * as childProcess from "child_process"

import { getRipgrepDiagnostic, registerRipgrepDiagnosticCommand, trySpawnRipgrep } from "../diagnostic"

const ripgrepMock = vi.hoisted(() => ({
	value: undefined as { rgPath?: string; loadError?: string } | undefined,
}))

const fsMock = vi.hoisted(() => ({
	existing: new Set<string>(),
}))

const getBinPathMock = vi.hoisted(() => ({ value: undefined as string | undefined }))

type SpawnResult = Awaited<ReturnType<typeof trySpawnRipgrep>>
const spawnMock = vi.hoisted(() => ({
	result: { stdout: "ripgrep 14.1.0", exitCode: 0 } as SpawnResult,
}))

function makeFakeProc(result: SpawnResult) {
	const proc = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter
		stderr: EventEmitter
		kill: () => void
	}
	proc.stdout = new EventEmitter()
	proc.stderr = new EventEmitter()
	proc.kill = vi.fn()
	setImmediate(() => {
		if (result.spawnError) {
			proc.emit("error", new Error(result.spawnError))
		} else if (result.timedOut) {
			proc.emit("close", null, "SIGTERM")
		} else {
			if (result.stdout) proc.stdout.emit("data", Buffer.from(result.stdout))
			if (result.stderr) proc.stderr.emit("data", Buffer.from(result.stderr))
			proc.emit("close", result.exitCode ?? 0, null)
		}
	})
	return proc
}

vi.mock("../internal/loadRipgrep", () => ({
	loadRipgrep: () => ripgrepMock.value,
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: (p: string) => Promise.resolve(fsMock.existing.has(p)),
}))

vi.mock("../index", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../index")>()
	return {
		...actual,
		getBinPath: () => Promise.resolve(getBinPathMock.value),
	}
})

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>()
	return { ...actual, spawn: vi.fn() }
})

const mockChannel = {
	clear: vi.fn(),
	appendLine: vi.fn(),
	show: vi.fn(),
	dispose: vi.fn(),
}

const mockCommand = { dispose: vi.fn() }

vi.mock("vscode", () => ({
	version: "1.99.0",
	env: { appRoot: "/mock/appRoot", clipboard: { writeText: vi.fn() } },
	window: {
		createOutputChannel: vi.fn(() => mockChannel),
		showInformationMessage: vi.fn(),
	},
	commands: { registerCommand: vi.fn(() => mockCommand) },
	Disposable: {
		from: vi.fn((...items: { dispose(): void }[]) => ({ dispose: () => items.forEach((d) => d.dispose()) })),
	},
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
		getBinPathMock.value = undefined
		spawnMock.result = { stdout: "ripgrep 14.1.0", exitCode: 0 }
		vi.mocked(childProcess.spawn).mockImplementation(() => makeFakeProc(spawnMock.result) as any)
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

	it("does not double-substitute when rgPath already contains node_modules.asar.unpacked", async () => {
		// A previous `\b` regex matched the `r`/`.` boundary inside
		// `node_modules.asar.unpacked`, producing `.unpacked.unpacked`.
		const rgPath = "/app/node_modules.asar.unpacked/foo/rg"
		ripgrepMock.value = { rgPath }
		fsMock.existing = new Set([rgPath])

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain(`after .asar→.asar.unpacked: ${rgPath}`)
		expect(report).not.toContain("node_modules.asar.unpacked.unpacked")
		expect(report).toContain("fileExistsAtPath: true")
	})

	it("reports require failure when loadRipgrep returns undefined", async () => {
		ripgrepMock.value = undefined

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain("loadRipgrep() returned undefined (require threw)")
	})

	it("reports the loadError when loadRipgrep returns a loadError field", async () => {
		ripgrepMock.value = { loadError: "Cannot find module '@vscode/ripgrep'" }

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain("loadRipgrep() returned loadError: Cannot find module '@vscode/ripgrep'")
		// Should not also push the success-branch lines.
		expect(report).not.toContain("after .asar→.asar.unpacked:")
		expect(report).not.toContain("rgPath:")
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

	it("rewrites node_modules.asar to node_modules.asar.unpacked on Windows paths (backslash separator)", async () => {
		// Pure string-substitution test: the literal `win32-x64` segment is
		// not derived from process.platform/arch, so this runs on any host.
		const rgPath = "C:\\app\\node_modules.asar\\@vscode\\ripgrep-universal\\bin\\win32-x64\\rg.exe"
		const substituted = "C:\\app\\node_modules.asar.unpacked\\@vscode\\ripgrep-universal\\bin\\win32-x64\\rg.exe"
		ripgrepMock.value = { rgPath }
		fsMock.existing = new Set([substituted])

		const report = await getRipgrepDiagnostic("C:\\app")

		expect(report).toContain(`after .asar→.asar.unpacked: ${substituted}`)
		expect(report).toContain("fileExistsAtPath: true")
	})

	it("returns an explanatory report when vscode.env.appRoot is empty", async () => {
		const report = await getRipgrepDiagnostic("")

		expect(report).toContain("vscode.env.appRoot: (empty)")
		expect(report).toContain("Cannot probe paths: vscode.env.appRoot is empty.")
		// step 1 should still run
		expect(report).toContain('--- step 1: require("@vscode/ripgrep") via loadRipgrep ---')
		// path probe and spawn test should NOT have run
		expect(report).not.toContain("--- step 2: path probe under appRoot ---")
		expect(report).not.toContain("--- step 3: spawn rg --version on selected path ---")
	})

	it("reports getBinPath() undefined when no candidate exists", async () => {
		getBinPathMock.value = undefined

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain("--- step 3: spawn rg --version on selected path ---")
		expect(report).toContain("getBinPath() returned undefined")
	})

	it("reports spawn success with exit code and stdout", async () => {
		getBinPathMock.value = expectedCandidates[4]
		fsMock.existing = new Set([expectedCandidates[4]])
		spawnMock.result = { stdout: "ripgrep 14.1.0", exitCode: 0 }

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain(`getBinPath() selected: ${expectedCandidates[4]}`)
		expect(report).toContain(`selectedPath JSON: ${JSON.stringify(expectedCandidates[4])}`)
		expect(report).toContain("exit code: 0")
		expect(report).toContain("stdout: ripgrep 14.1.0")
	})

	it("reports spawn ENOENT — the file-exists-but-spawn-fails failure mode", async () => {
		getBinPathMock.value = expectedCandidates[4]
		fsMock.existing = new Set([expectedCandidates[4]])
		spawnMock.result = { spawnError: "spawn ENOENT" }

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain("spawn error: spawn ENOENT")
		expect(report).not.toContain("exit code:")
	})

	it("passes the selected path, ['--version'], and timeout option to spawn", async () => {
		getBinPathMock.value = expectedCandidates[4]
		fsMock.existing = new Set([expectedCandidates[4]])

		await getRipgrepDiagnostic(APP_ROOT)

		expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledWith(expectedCandidates[4], ["--version"], {
			timeout: 5_000,
		})
	})

	it("reports timed out when the process is killed with SIGTERM", async () => {
		getBinPathMock.value = expectedCandidates[4]
		fsMock.existing = new Set([expectedCandidates[4]])
		spawnMock.result = { timedOut: true }

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain("timed out after 5000ms")
		expect(report).not.toContain("exit code:")
	})

	it("reports stderr when the process exits with a non-zero code", async () => {
		getBinPathMock.value = expectedCandidates[4]
		fsMock.existing = new Set([expectedCandidates[4]])
		spawnMock.result = { exitCode: 1, stderr: "error: unrecognised flag" }

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain("exit code: 1")
		expect(report).toContain("stderr: error: unrecognised flag")
	})

	it("omits the stderr line when stderr is empty", async () => {
		getBinPathMock.value = expectedCandidates[4]
		fsMock.existing = new Set([expectedCandidates[4]])
		spawnMock.result = { stdout: "ripgrep 14.1.0", exitCode: 0, stderr: "" }

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).not.toContain("stderr:")
	})

	it("includes JSON-escaped path for the rgPath from loadRipgrep", async () => {
		ripgrepMock.value = { rgPath: "/path/with spaces/rg" }
		fsMock.existing = new Set(["/path/with spaces/rg"])

		const report = await getRipgrepDiagnostic(APP_ROOT)

		expect(report).toContain(`rgPath JSON: ${JSON.stringify("/path/with spaces/rg")}`)
	})
})

describe("registerRipgrepDiagnosticCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		ripgrepMock.value = undefined
		fsMock.existing = new Set()
	})

	it("creates an output channel and registers the command", () => {
		registerRipgrepDiagnosticCommand()

		expect(vscode.window.createOutputChannel).toHaveBeenCalledWith("Zoo Code Ripgrep Diagnostic")
		expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
			expect.stringContaining("showRipgrepDiagnostic"),
			expect.any(Function),
		)
	})

	it("returns a Disposable that disposes both the command and channel", () => {
		const disposable = registerRipgrepDiagnosticCommand()
		disposable.dispose()

		expect(vscode.Disposable.from).toHaveBeenCalledWith(mockCommand, mockChannel)
	})

	it("clears, appends, and shows the channel when the command runs", async () => {
		registerRipgrepDiagnosticCommand()

		const [[, handler]] = vi.mocked(vscode.commands.registerCommand).mock.calls
		await handler()

		expect(mockChannel.clear).toHaveBeenCalled()
		expect(mockChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Zoo Code Ripgrep Diagnostic"))
		expect(mockChannel.show).toHaveBeenCalledWith(true)
	})

	it("writes the report to the clipboard and shows a toast when the command runs", async () => {
		registerRipgrepDiagnosticCommand()

		const [[, handler]] = vi.mocked(vscode.commands.registerCommand).mock.calls
		await handler()

		expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
			expect.stringContaining("Zoo Code Ripgrep Diagnostic"),
		)
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"Zoo Code: ripgrep diagnostic copied to clipboard.",
		)
	})
})
