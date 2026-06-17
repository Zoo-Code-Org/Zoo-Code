// npx vitest utils/__tests__/path.spec.ts

import os from "os"
import * as path from "path"

// `vscode` resolves to `src/__mocks__/vscode.js` (see src/vitest.config.ts
// resolve.alias). We import it here so the workspace-root tests can mutate
// the shared mock object directly; inline `vi.mock("vscode", ...)` is a no-op
// against a `resolve.alias` mapping.
import * as vscodeMock from "vscode"

import { arePathsEqual, getReadablePath, getWorkspacePath, getWorkspacePathForContext } from "../path"

// Loose typing for the mock object — the file is plain JS and exposes a
// hand-rolled subset of the VS Code API.
const mockWorkspace = (
	vscodeMock as unknown as {
		workspace: {
			workspaceFolders: Array<{ uri: { fsPath: string }; name: string; index: number }> | undefined
			getWorkspaceFolder: (...args: unknown[]) => { uri: { fsPath: string } } | null | undefined
			getConfiguration: (section?: string) => { get: (key: string, defaultValue?: unknown) => unknown }
		}
		window: {
			activeTextEditor: { document: { uri: { fsPath: string } } } | null
		}
	}
).workspace
const mockWindow = (
	vscodeMock as unknown as {
		window: { activeTextEditor: { document: { uri: { fsPath: string } } } | null }
	}
).window

/**
 * Set the value returned for `zoo-code.workspace.rootResolution` in tests.
 * Pass `undefined` to fall back to the default ("activeEditor").
 */
function setRootResolution(value: "activeEditor" | "firstFolder" | undefined) {
	mockWorkspace.getConfiguration = (section?: string) => ({
		get: (key: string, defaultValue?: unknown) => {
			if (section === "zoo-code" && key === "workspace.rootResolution") {
				return value ?? defaultValue
			}
			return defaultValue
		},
	})
}

/**
 * Configure the mock workspace folders + active editor for a single test.
 * Returns a cleanup callback that restores the previous state.
 */
function withWorkspaceMock(opts: {
	folders?: Array<{ uri: { fsPath: string }; name: string; index: number }> | undefined
	getWorkspaceFolder?: (...args: unknown[]) => { uri: { fsPath: string } } | null | undefined
	activeEditor?: { document: { uri: { fsPath: string } } } | null
	getConfiguration?: (section?: string) => { get: (key: string, defaultValue?: unknown) => unknown }
}): () => void {
	const previousFolders = mockWorkspace.workspaceFolders
	const previousGetWorkspaceFolder = mockWorkspace.getWorkspaceFolder
	const previousActiveEditor = mockWindow.activeTextEditor
	// Capture getConfiguration too: tests that mutate it must not leak a broken
	// mock into sibling tests if the outer beforeEach is ever changed or moved.
	const previousGetConfiguration = mockWorkspace.getConfiguration

	if ("folders" in opts) mockWorkspace.workspaceFolders = opts.folders
	if (opts.getWorkspaceFolder) mockWorkspace.getWorkspaceFolder = opts.getWorkspaceFolder
	if ("activeEditor" in opts) mockWindow.activeTextEditor = opts.activeEditor ?? null
	if (opts.getConfiguration) mockWorkspace.getConfiguration = opts.getConfiguration

	return () => {
		mockWorkspace.workspaceFolders = previousFolders
		mockWorkspace.getWorkspaceFolder = previousGetWorkspaceFolder
		mockWindow.activeTextEditor = previousActiveEditor
		mockWorkspace.getConfiguration = previousGetConfiguration
	}
}

describe("Path Utilities", () => {
	const originalPlatform = process.platform
	// Helper to mock VS Code configuration

	beforeEach(() => {
		// Default to legacy "activeEditor" behavior unless a test opts in.
		setRootResolution(undefined)
	})

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: originalPlatform,
		})
	})

	describe("String.prototype.toPosix", () => {
		it("should convert backslashes to forward slashes", () => {
			const windowsPath = "C:\\Users\\test\\file.txt"
			expect(windowsPath.toPosix()).toBe("C:/Users/test/file.txt")
		})

		it("should not modify paths with forward slashes", () => {
			const unixPath = "/home/user/file.txt"
			expect(unixPath.toPosix()).toBe("/home/user/file.txt")
		})

		it("should preserve extended-length Windows paths", () => {
			const extendedPath = "\\\\?\\C:\\Very\\Long\\Path"
			expect(extendedPath.toPosix()).toBe("\\\\?\\C:\\Very\\Long\\Path")
		})
	})
	describe("getWorkspacePath", () => {
		it("should return the current workspace path", () => {
			const workspacePath = "/Users/test/project"
			expect(getWorkspacePath(workspacePath)).toBe("/Users/test/project")
		})

		describe("rootResolution = 'activeEditor' (default)", () => {
			it("prefers the workspace folder containing the active editor", () => {
				setRootResolution("activeEditor")
				const restore = withWorkspaceMock({
					folders: [{ uri: { fsPath: "/test/workspace" }, name: "test", index: 0 }],
					activeEditor: { document: { uri: { fsPath: "/test/workspaceFolder/file.ts" } } },
					getWorkspaceFolder: () => ({ uri: { fsPath: "/test/workspaceFolder" } }),
				})
				try {
					expect(getWorkspacePath()).toBe("/test/workspaceFolder")
				} finally {
					restore()
				}
			})

			it("falls back to workspaceFolders[0] when the active file is outside any workspace folder", () => {
				setRootResolution("activeEditor")
				const restore = withWorkspaceMock({
					folders: [{ uri: { fsPath: "/test/workspace" }, name: "test", index: 0 }],
					activeEditor: { document: { uri: { fsPath: "/somewhere/else/file.ts" } } },
					getWorkspaceFolder: () => null,
				})
				try {
					expect(getWorkspacePath()).toBe("/test/workspace")
				} finally {
					restore()
				}
			})

			it("falls back to defaultCwdPath when there are no workspace folders and no active editor folder", () => {
				setRootResolution("activeEditor")
				const restore = withWorkspaceMock({
					folders: undefined,
					activeEditor: null,
					getWorkspaceFolder: () => null,
				})
				try {
					expect(getWorkspacePath("/fallback")).toBe("/fallback")
				} finally {
					restore()
				}
			})
		})

		describe("rootResolution = 'firstFolder'", () => {
			it("ignores the active editor and always returns workspaceFolders[0]", () => {
				setRootResolution("firstFolder")
				const restore = withWorkspaceMock({
					folders: [
						{ uri: { fsPath: "/test/workspace" }, name: "test", index: 0 },
						{ uri: { fsPath: "/test/secondary" }, name: "secondary", index: 1 },
					],
					activeEditor: { document: { uri: { fsPath: "/test/secondary/file.ts" } } },
					getWorkspaceFolder: () => ({ uri: { fsPath: "/test/secondary" } }),
				})
				try {
					expect(getWorkspacePath()).toBe("/test/workspace")
				} finally {
					restore()
				}
			})

			it("does not consult getWorkspaceFolder at all", () => {
				setRootResolution("firstFolder")
				const spy = vi.fn(() => ({ uri: { fsPath: "/test/secondary" } }))
				const restore = withWorkspaceMock({
					folders: [{ uri: { fsPath: "/test/workspace" }, name: "test", index: 0 }],
					activeEditor: { document: { uri: { fsPath: "/test/secondary/file.ts" } } },
					getWorkspaceFolder: spy,
				})
				try {
					getWorkspacePath()
					expect(spy).not.toHaveBeenCalled()
				} finally {
					restore()
				}
			})

			it("falls back to defaultCwdPath when there are no workspace folders", () => {
				setRootResolution("firstFolder")
				const restore = withWorkspaceMock({
					folders: undefined,
					activeEditor: null,
					getWorkspaceFolder: () => null,
				})
				try {
					expect(getWorkspacePath("/fallback")).toBe("/fallback")
				} finally {
					restore()
				}
			})
		})

		it("falls back to default behavior when reading the setting throws", () => {
			// Route the throwing config mock through withWorkspaceMock so it is
			// restored by the cleanup callback and cannot leak into sibling tests.
			const restore = withWorkspaceMock({
				folders: [{ uri: { fsPath: "/test/workspace" }, name: "test", index: 0 }],
				activeEditor: { document: { uri: { fsPath: "/test/workspaceFolder/file.ts" } } },
				getWorkspaceFolder: () => ({ uri: { fsPath: "/test/workspaceFolder" } }),
				getConfiguration: () => {
					throw new Error("not available in this context")
				},
			})
			try {
				// Should not throw and should resolve via active-editor logic.
				expect(getWorkspacePath()).toBe("/test/workspaceFolder")
			} finally {
				restore()
			}
		})
	})

	describe("getWorkspacePathForContext", () => {
		it("(activeEditor) returns the workspace folder for the given path", () => {
			setRootResolution("activeEditor")
			const restore = withWorkspaceMock({
				folders: [{ uri: { fsPath: "/test/workspace" }, name: "test", index: 0 }],
				activeEditor: null,
				getWorkspaceFolder: (uri: unknown) => {
					const u = uri as { fsPath?: string } | undefined
					if (u?.fsPath?.startsWith("/some/other/workspace")) {
						return { uri: { fsPath: "/some/other/workspace" } }
					}
					return null
				},
			})
			try {
				expect(getWorkspacePathForContext("/some/other/workspace/file.ts")).toBe("/some/other/workspace")
			} finally {
				restore()
			}
		})

		it("(activeEditor) falls back to getWorkspacePath when the context path has no workspace folder", () => {
			setRootResolution("activeEditor")
			// contextPath is provided but getWorkspaceFolder returns null, exercising
			// the console.debug fallback branch in getWorkspacePathForContext.
			const restore = withWorkspaceMock({
				folders: [{ uri: { fsPath: "/test/workspace" }, name: "test", index: 0 }],
				activeEditor: null,
				getWorkspaceFolder: () => null,
			})
			try {
				expect(getWorkspacePathForContext("/unknown/path/file.ts")).toBe("/test/workspace")
			} finally {
				restore()
			}
		})

		it("(firstFolder) ignores the context path and returns workspaceFolders[0]", () => {
			setRootResolution("firstFolder")
			const spy = vi.fn(() => ({ uri: { fsPath: "/some/other/workspace" } }))
			const restore = withWorkspaceMock({
				folders: [{ uri: { fsPath: "/test/workspace" }, name: "test", index: 0 }],
				activeEditor: null,
				getWorkspaceFolder: spy,
			})
			try {
				expect(getWorkspacePathForContext("/some/other/workspace/file.ts")).toBe("/test/workspace")
				// Should not have looked up the context path's workspace folder.
				expect(spy).not.toHaveBeenCalled()
			} finally {
				restore()
			}
		})
	})
	describe("arePathsEqual", () => {
		describe("on Windows", () => {
			beforeEach(() => {
				Object.defineProperty(process, "platform", {
					value: "win32",
				})
			})

			it("should compare paths case-insensitively", () => {
				expect(arePathsEqual("C:\\Users\\Test", "c:\\users\\test")).toBe(true)
			})

			it("should handle different path separators", () => {
				// Convert both paths to use forward slashes after normalization
				const path1 = path.normalize("C:\\Users\\Test").replace(/\\/g, "/")
				const path2 = path.normalize("C:/Users/Test").replace(/\\/g, "/")
				expect(arePathsEqual(path1, path2)).toBe(true)
			})

			it("should normalize paths with ../", () => {
				// Convert both paths to use forward slashes after normalization
				const path1 = path.normalize("C:\\Users\\Test\\..\\Test").replace(/\\/g, "/")
				const path2 = path.normalize("C:\\Users\\Test").replace(/\\/g, "/")
				expect(arePathsEqual(path1, path2)).toBe(true)
			})
		})

		describe("on POSIX", () => {
			beforeEach(() => {
				Object.defineProperty(process, "platform", {
					value: "darwin",
				})
			})

			it("should compare paths case-sensitively", () => {
				expect(arePathsEqual("/Users/Test", "/Users/test")).toBe(false)
			})

			it("should normalize paths", () => {
				expect(arePathsEqual("/Users/./Test", "/Users/Test")).toBe(true)
			})

			it("should handle trailing slashes", () => {
				expect(arePathsEqual("/Users/Test/", "/Users/Test")).toBe(true)
			})
		})

		describe("edge cases", () => {
			it("should handle undefined paths", () => {
				expect(arePathsEqual(undefined, undefined)).toBe(true)
				expect(arePathsEqual("/test", undefined)).toBe(false)
				expect(arePathsEqual(undefined, "/test")).toBe(false)
			})

			it("should handle root paths with trailing slashes", () => {
				expect(arePathsEqual("/", "/")).toBe(true)
				expect(arePathsEqual("C:\\", "C:\\")).toBe(true)
			})
		})
	})

	describe("getReadablePath", () => {
		const homeDir = os.homedir()
		const desktop = path.join(homeDir, "Desktop")
		const cwd = process.platform === "win32" ? "C:\\Users\\test\\project" : "/Users/test/project"

		it("should return basename when path equals cwd", () => {
			expect(getReadablePath(cwd, cwd)).toBe("project")
		})

		it("should return relative path when inside cwd", () => {
			const filePath =
				process.platform === "win32"
					? "C:\\Users\\test\\project\\src\\file.txt"
					: "/Users/test/project/src/file.txt"
			expect(getReadablePath(cwd, filePath)).toBe("src/file.txt")
		})

		it("should return absolute path when outside cwd", () => {
			const filePath =
				process.platform === "win32" ? "C:\\Users\\test\\other\\file.txt" : "/Users/test/other/file.txt"
			expect(getReadablePath(cwd, filePath)).toBe(filePath.toPosix())
		})

		it("should handle Desktop as cwd", () => {
			const filePath = path.join(desktop, "file.txt")
			expect(getReadablePath(desktop, filePath)).toBe(filePath.toPosix())
		})

		it("should return empty string when relative path is undefined", () => {
			expect(getReadablePath(cwd)).toBe("")
		})

		it("should return cwd basename when relative path is empty string", () => {
			// Empty string resolves to cwd, which returns basename
			expect(getReadablePath(cwd, "")).toBe("project")
		})

		it("should handle parent directory traversal", () => {
			const filePath =
				process.platform === "win32" ? "C:\\Users\\test\\other\\file.txt" : "/Users/test/other/file.txt"
			expect(getReadablePath(cwd, filePath)).toBe(filePath.toPosix())
		})

		it("should normalize paths with redundant segments", () => {
			const filePath =
				process.platform === "win32"
					? "C:\\Users\\test\\project\\src\\file.txt"
					: "/Users/test/project/./src/../src/file.txt"
			expect(getReadablePath(cwd, filePath)).toBe("src/file.txt")
		})
	})
})
