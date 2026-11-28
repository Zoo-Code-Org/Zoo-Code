import path from "path"
import os from "os"
import * as vscode from "vscode"

import { isPathOutsideWorkspace } from "../pathUtils"

vi.mock("vscode", () => ({ workspace: { workspaceFolders: [] } }))

describe("isPathOutsideWorkspace with multiple roots", () => {
	const parent = path.join(os.tmpdir(), "zoo-multi-root")
	const first = path.join(parent, "first")
	const second = path.join(parent, "second")

	beforeEach(() => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			value: [{ uri: { fsPath: first } }, { uri: { fsPath: second } }],
		})
	})

	it("accepts a file in either root and rejects a similarly named sibling", () => {
		expect(isPathOutsideWorkspace(path.join(first, "src", "one.ts"))).toBe(false)
		expect(isPathOutsideWorkspace(path.join(second, "src", "two.ts"))).toBe(false)
		expect(isPathOutsideWorkspace(path.join(parent, "second-copy", "two.ts"))).toBe(true)
	})

	it.skipIf(process.platform !== "win32")("uses Windows case-insensitive path semantics", () => {
		expect(isPathOutsideWorkspace(path.join(second.toUpperCase(), "SRC", "two.ts"))).toBe(false)
	})
})
