// npx vitest utils/__tests__/export.spec.ts

import * as path from "path"

import { constants } from "fs/promises"

import type * as vscode from "vscode"

import { resolveDefaultSaveUri, saveLastExportPath } from "../export"

import type { ExportContext, ExportOptions } from "../export"

const mocks = vi.hoisted(() => ({
	workspaceFolders: undefined as undefined | { uri: { fsPath: string } }[],
	uriFile: vi.fn((filePath: string) => ({ fsPath: filePath })),
	stat: vi.fn(),
	access: vi.fn(),
}))

vi.mock("vscode", () => ({
	Uri: { file: mocks.uriFile },
	workspace: {
		get workspaceFolders() {
			return mocks.workspaceFolders
		},
	},
}))

// `utils/export` checks the target directory with the named fs/promises
// exports, so the mock has to expose them as named exports too.
vi.mock("fs/promises", () => {
	const fsPromises = { stat: mocks.stat, access: mocks.access, constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 } }
	return { ...fsPromises, default: fsPromises }
})

// Build every expected path with `path` helpers so the assertions hold on
// both win32 and POSIX runners.
const REMEMBERED_DIR = path.join("/usb")
const REMEMBERED = path.join(REMEMBERED_DIR, "zoo-code-settings.json")
const FALLBACK = path.join("/mock/home", "Downloads")

function makeContext(remembered?: string): ExportContext {
	return {
		// Key-sensitive so a resolver that reads the wrong setting key is caught.
		getValue: vi.fn((key: string) => (key === "lastSettingsExportPath" ? remembered : undefined)),
		setValue: vi.fn().mockResolvedValue(undefined),
	}
}

async function resolveWith(remembered: string | undefined, options: ExportOptions = {}) {
	const uri = await resolveDefaultSaveUri(
		makeContext(remembered),
		"lastSettingsExportPath",
		"zoo-code-settings.json",
		options,
	)
	return uri.fsPath
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.workspaceFolders = undefined
	mocks.stat.mockResolvedValue({ isDirectory: () => true })
	mocks.access.mockResolvedValue(undefined)
})

describe("resolveDefaultSaveUri", () => {
	it("uses the remembered directory while it is still a writable directory", async () => {
		const resolved = await resolveWith(REMEMBERED, { useWorkspace: false })

		expect(resolved).toBe(REMEMBERED)
		expect(mocks.stat).toHaveBeenCalledWith(REMEMBERED_DIR)
		expect(mocks.access).toHaveBeenCalledWith(REMEMBERED_DIR, constants.W_OK | constants.X_OK)
	})

	it("prefers the remembered directory over the workspace folder while it is still usable", async () => {
		// The documented priority is remembered path before workspace folder, and the
		// remembered branch does not consult useWorkspace, so the order has to be proven
		// with a live remembered directory and the default options.
		mocks.workspaceFolders = [{ uri: { fsPath: "/workspace" } }]

		const resolved = await resolveWith(REMEMBERED, {})

		expect(resolved).toBe(REMEMBERED)
		expect(resolved).not.toBe(path.join("/workspace", "zoo-code-settings.json"))
	})

	it("checks write permission instead of existence alone", async () => {
		await resolveWith(REMEMBERED, { useWorkspace: false })

		expect(mocks.access).toHaveBeenCalledWith(REMEMBERED_DIR, constants.W_OK | constants.X_OK)
		expect(mocks.access).not.toHaveBeenCalledWith(REMEMBERED_DIR, constants.R_OK | constants.X_OK)
	})

	it("falls back when the remembered directory no longer exists", async () => {
		mocks.stat.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		const resolved = await resolveWith(REMEMBERED, { useWorkspace: false, fallbackDir: FALLBACK })

		expect(resolved).toBe(path.join(FALLBACK, "zoo-code-settings.json"))
	})

	it("falls back when the remembered path was remounted under a missing drive", async () => {
		const deadUsb = path.join("Z:\\gone", "zoo-code-settings.json")
		mocks.stat.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		const resolved = await resolveWith(deadUsb, { useWorkspace: false, fallbackDir: FALLBACK })

		expect(resolved).toBe(path.join(FALLBACK, "zoo-code-settings.json"))
		expect(mocks.stat).toHaveBeenCalledWith(path.dirname(deadUsb))
	})

	it("falls back when the remembered directory became a regular file", async () => {
		mocks.stat.mockResolvedValueOnce({ isDirectory: () => false })

		const resolved = await resolveWith(REMEMBERED, { useWorkspace: false, fallbackDir: FALLBACK })

		expect(resolved).toBe(path.join(FALLBACK, "zoo-code-settings.json"))
	})

	it("falls back when the remembered directory is read-only", async () => {
		mocks.access.mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }))

		const resolved = await resolveWith(REMEMBERED, { useWorkspace: false, fallbackDir: FALLBACK })

		expect(resolved).toBe(path.join(FALLBACK, "zoo-code-settings.json"))
	})

	it("keeps a read-only remembered directory when the caller only reads from it", async () => {
		// A read-only volume: write access fails, read access succeeds.
		mocks.access.mockImplementation((_dir: string, mode: number) =>
			(mode & constants.W_OK) === constants.W_OK
				? Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))
				: Promise.resolve(),
		)

		const resolved = await resolveWith(REMEMBERED, {
			useWorkspace: false,
			fallbackDir: FALLBACK,
			accessMode: constants.R_OK,
		})

		expect(resolved).toBe(REMEMBERED)
		// Traversal is part of the check even when only reading is required.
		expect(mocks.access).toHaveBeenCalledWith(REMEMBERED_DIR, constants.R_OK | constants.X_OK)
	})

	it("falls back when the remembered directory cannot be read either", async () => {
		mocks.access.mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }))

		const resolved = await resolveWith(REMEMBERED, {
			useWorkspace: false,
			fallbackDir: FALLBACK,
			accessMode: constants.R_OK,
		})

		expect(resolved).toBe(path.join(FALLBACK, "zoo-code-settings.json"))
	})

	it("uses the workspace folder when the remembered path is dead", async () => {
		mocks.workspaceFolders = [{ uri: { fsPath: "/workspace" } }]
		mocks.stat.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		const resolved = await resolveWith(REMEMBERED, { fallbackDir: FALLBACK })

		expect(resolved).toBe(path.join("/workspace", "zoo-code-settings.json"))
	})

	it("uses the workspace folder when no remembered path exists", async () => {
		mocks.workspaceFolders = [{ uri: { fsPath: "/workspace" } }]

		const resolved = await resolveWith(undefined, { fallbackDir: FALLBACK })

		expect(resolved).toBe(path.join("/workspace", "zoo-code-settings.json"))
		expect(mocks.stat).not.toHaveBeenCalled()
	})

	it("skips the workspace folder when useWorkspace is false", async () => {
		mocks.workspaceFolders = [{ uri: { fsPath: "/workspace" } }]

		const resolved = await resolveWith(undefined, { useWorkspace: false, fallbackDir: FALLBACK })

		expect(resolved).toBe(path.join(FALLBACK, "zoo-code-settings.json"))
	})

	it("skips an empty workspace folder list instead of indexing into it", async () => {
		mocks.workspaceFolders = []

		const resolved = await resolveWith(undefined, { fallbackDir: FALLBACK })

		expect(resolved).toBe(path.join(FALLBACK, "zoo-code-settings.json"))
	})

	it("uses the fallback directory when nothing else is available", async () => {
		const resolved = await resolveWith(undefined, { fallbackDir: FALLBACK })

		expect(resolved).toBe(path.join(FALLBACK, "zoo-code-settings.json"))
	})

	it("falls back to the bare filename when no directory is configured", async () => {
		const resolved = await resolveWith(undefined, { useWorkspace: false })

		expect(resolved).toBe("zoo-code-settings.json")
	})
})

describe("saveLastExportPath", () => {
	it("stores the chosen file path under the requested key", async () => {
		const context = makeContext()

		// The mocked vscode module has no Uri implementation, and saveLastExportPath
		// only reads `fsPath`.
		const chosen = { fsPath: "/usb/zoo-code-settings.json" } as unknown as vscode.Uri

		await saveLastExportPath(context, "lastSettingsExportPath", chosen)

		expect(context.setValue).toHaveBeenCalledWith("lastSettingsExportPath", "/usb/zoo-code-settings.json")
	})
})
