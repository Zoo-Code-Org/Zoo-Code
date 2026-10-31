import * as vscode from "vscode"
import { makeWorkspaceConfiguration } from "../../test-utils/vscode"

vi.mock("fs/promises", async () => {
	const mod = await import("../../__mocks__/fs/promises")
	type FsPromisesMockModule = typeof mod & { default?: typeof mod }
	return (mod as FsPromisesMockModule).default ?? mod
})

describe("getStorageBasePath - customStoragePath", () => {
	const defaultPath = "/test/global-storage"

	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("returns the configured custom path when it is writable", async () => {
		const customPath = "/test/storage/path"
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(
			makeWorkspaceConfiguration({ customStoragePath: customPath }),
		)

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(customPath)
		expect(fsPromises.mkdir).toHaveBeenCalledWith(customPath, { recursive: true })
		expect(fsPromises.access).toHaveBeenCalledWith(customPath, 7) // 7 = R_OK(4) | W_OK(2) | X_OK(1)
	})

	it("falls back to default and shows an error when custom path is not writable", async () => {
		const customPath = "/test/storage/unwritable"

		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(
			makeWorkspaceConfiguration({ customStoragePath: customPath }),
		)

		const showErrorSpy = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")

		await fsPromises.mkdir(customPath, { recursive: true })

		const accessMock = vi.mocked(fsPromises.access)
		accessMock.mockImplementationOnce(async (p) => {
			if (p === customPath) {
				const err = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
				err.code = "EACCES"
				throw err
			}
			return Promise.resolve()
		})

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect(showErrorSpy).toHaveBeenCalledTimes(1)
		const firstArg = showErrorSpy.mock.calls[0][0]
		expect(typeof firstArg).toBe("string")
	})
	it("returns the default path when customStoragePath is an empty string and does not touch fs", async () => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(
			makeWorkspaceConfiguration({ customStoragePath: "" }),
		)

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect(fsPromises.mkdir).not.toHaveBeenCalled()
		expect(fsPromises.access).not.toHaveBeenCalled()
	})

	it("falls back to default when mkdir fails and does not attempt access", async () => {
		const customPath = "/test/storage/failmkdir"

		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(
			makeWorkspaceConfiguration({ customStoragePath: customPath }),
		)

		const showErrorSpy = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")

		const mkdirMock = vi.mocked(fsPromises.mkdir)
		mkdirMock.mockImplementationOnce(async (p) => {
			if (p === customPath) {
				const err = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
				err.code = "EACCES"
				throw err
			}
			return undefined
		})

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect(fsPromises.access).not.toHaveBeenCalled()
		expect(showErrorSpy).toHaveBeenCalledTimes(1)
	})

	it("passes the correct permission flags (R_OK | W_OK | X_OK) to fs.access", async () => {
		const customPath = "/test/storage/path"
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(
			makeWorkspaceConfiguration({ customStoragePath: customPath }),
		)

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")

		await getStorageBasePath(defaultPath)

		const constants = fsPromises.constants
		const expectedFlags = constants.R_OK | constants.W_OK | constants.X_OK

		expect(fsPromises.access).toHaveBeenCalledWith(customPath, expectedFlags)
	})

	it("falls back when directory is readable but not writable (partial permissions)", async () => {
		const customPath = "/test/storage/readonly"
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(
			makeWorkspaceConfiguration({ customStoragePath: customPath }),
		)

		const showErrorSpy = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")

		const accessMock = vi.mocked(fsPromises.access)
		const constants = fsPromises.constants
		accessMock.mockImplementationOnce(async (p, mode) => {
			// Simulate readable (R_OK) but not writable/executable (W_OK | X_OK)
			if (p === customPath && mode && mode & (constants.W_OK | constants.X_OK)) {
				const err = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
				err.code = "EACCES"
				throw err
			}
			return Promise.resolve()
		})

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect(showErrorSpy).toHaveBeenCalledTimes(1)
	})
})
