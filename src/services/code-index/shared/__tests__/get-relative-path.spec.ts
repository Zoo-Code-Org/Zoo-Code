import path from "path"

import { generateRelativeFilePath } from "../get-relative-path"

describe("get-relative-path", () => {
	describe("generateRelativeFilePath", () => {
		it("should use provided workspace root", () => {
			const workspaceRoot = path.join(path.sep, "custom", "workspace")
			const absolutePath = path.join(workspaceRoot, "src", "file.ts")
			const result = generateRelativeFilePath(absolutePath, workspaceRoot)
			expect(result).toBe(path.join("src", "file.ts"))
		})

		it("should handle paths outside workspace", () => {
			const absolutePath = path.join(path.sep, "outside", "workspace", "file.ts")
			const workspaceRoot = path.join(path.sep, "custom", "workspace")
			const result = generateRelativeFilePath(absolutePath, workspaceRoot)
			// The result will have .. segments to navigate outside
			expect(result).toContain("..")
		})

		it("should handle same path as workspace", () => {
			const workspaceRoot = path.join(path.sep, "custom", "workspace")
			const absolutePath = workspaceRoot
			const result = generateRelativeFilePath(absolutePath, workspaceRoot)
			expect(result).toBe(".")
		})

		it("should handle multi-workspace scenarios", () => {
			// Simulate the error scenario from the issue
			const workspaceRoot = path.join(path.sep, "Users", "test", "project")
			const absolutePath = path.join(path.sep, "Users", "test", "admin", ".prettierrc.json")
			const result = generateRelativeFilePath(absolutePath, workspaceRoot)
			// Should generate a valid relative path, not throw an error
			expect(result).toBe(path.join("..", "admin", ".prettierrc.json"))
		})
	})
})
