import {
	getProjectBooDirectoryForCwd,
	getGlobalBooDirectory,
	directoryExists,
	fileExists,
	readFileIfExists,
	getBooDirectoriesForCwd,
	readProjectBooConfig,
} from "../index"
import path from "path"
import fs from "fs/promises"
import os from "os"

describe("boo-config", () => {
	describe("getProjectBooDirectoryForCwd", () => {
		it("returns .boo directory path for given cwd", () => {
			const result = getProjectBooDirectoryForCwd("/Users/john/my-project")
			expect(result).toBe(path.join("/Users/john/my-project", ".boo"))
		})

		it("handles Windows paths", () => {
			const result = getProjectBooDirectoryForCwd("C:\\Users\\john\\my-project")
			expect(result).toBe(path.join("C:\\Users\\john\\my-project", ".boo"))
		})
	})

	describe("getGlobalBooDirectory", () => {
		it("returns .boo in home directory", () => {
			const result = getGlobalBooDirectory()
			expect(result).toContain(".boo")
			expect(result).toContain(os.homedir())
		})
	})

	describe("directoryExists", () => {
		it("returns true for existing directory", async () => {
			const result = await directoryExists("/tmp")
			expect(result).toBe(true)
		})

		it("returns false for nonexistent directory", async () => {
			const result = await directoryExists("/nonexistent/path/xyz")
			expect(result).toBe(false)
		})
	})

	describe("fileExists", () => {
		it("returns true for existing file", async () => {
			const tmpFile = path.join(os.tmpdir(), "test-file.txt")
			await fs.writeFile(tmpFile, "test")
			const result = await fileExists(tmpFile)
			expect(result).toBe(true)
			await fs.unlink(tmpFile)
		})

		it("returns false for nonexistent file", async () => {
			const result = await fileExists("/nonexistent/file.txt")
			expect(result).toBe(false)
		})
	})

	describe("readFileIfExists", () => {
		it("returns file content if file exists", async () => {
			const tmpFile = path.join(os.tmpdir(), "test-read.txt")
			await fs.writeFile(tmpFile, "hello world")
			const result = await readFileIfExists(tmpFile)
			expect(result).toBe("hello world")
			await fs.unlink(tmpFile)
		})

		it("returns null if file does not exist", async () => {
			const result = await readFileIfExists("/nonexistent/file.txt")
			expect(result).toBeNull()
		})
	})

	describe("getBooDirectoriesForCwd", () => {
		it("returns global and project directories in order", () => {
			const result = getBooDirectoriesForCwd("/Users/john/project")
			expect(result.length).toBe(2)
			expect(result[0]).toContain(".boo")
			expect(result[1]).toBe("/Users/john/project/.boo")
		})
	})

	describe("boo-config exports", () => {
		it("exports all public functions", () => {
			expect(typeof getGlobalBooDirectory).toBe("function")
			expect(typeof getProjectBooDirectoryForCwd).toBe("function")
			expect(typeof directoryExists).toBe("function")
			expect(typeof fileExists).toBe("function")
			expect(typeof readFileIfExists).toBe("function")
			expect(typeof getBooDirectoriesForCwd).toBe("function")
			expect(typeof readProjectBooConfig).toBe("function")
		})
	})

	describe("readProjectBooConfig", () => {
		let tmpDir: string

		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "boo-config-test-"))
			await fs.mkdir(path.join(tmpDir, ".boo"), { recursive: true })
		})

		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true })
		})

		it("returns {} when config.yaml is missing", async () => {
			const result = await readProjectBooConfig(tmpDir)
			expect(result).toEqual({})
		})

		it("returns {} when config.yaml has invalid YAML", async () => {
			await fs.writeFile(path.join(tmpDir, ".boo", "config.yaml"), "collaborate: [invalid: yaml: here")
			const result = await readProjectBooConfig(tmpDir)
			expect(result).toEqual({})
		})

		it("returns {} when config.yaml is empty", async () => {
			await fs.writeFile(path.join(tmpDir, ".boo", "config.yaml"), "")
			const result = await readProjectBooConfig(tmpDir)
			expect(result).toEqual({})
		})

		it("returns null drafting_profile when field is blank string", async () => {
			await fs.writeFile(path.join(tmpDir, ".boo", "config.yaml"), `collaborate:\n  drafting_profile: ""\n`)
			const result = await readProjectBooConfig(tmpDir)
			expect(result).toEqual({ collaborate: { drafting_profile: null } })
		})

		it("returns null drafting_profile when field is whitespace", async () => {
			await fs.writeFile(path.join(tmpDir, ".boo", "config.yaml"), `collaborate:\n  drafting_profile: "   "\n`)
			const result = await readProjectBooConfig(tmpDir)
			expect(result).toEqual({ collaborate: { drafting_profile: null } })
		})

		it("returns the profile name when drafting_profile is set", async () => {
			await fs.writeFile(
				path.join(tmpDir, ".boo", "config.yaml"),
				`collaborate:\n  drafting_profile: "haiku-fast"\n`,
			)
			const result = await readProjectBooConfig(tmpDir)
			expect(result).toEqual({ collaborate: { drafting_profile: "haiku-fast" } })
		})

		it("returns {} when collaborate section is missing", async () => {
			await fs.writeFile(path.join(tmpDir, ".boo", "config.yaml"), `other_key: value\n`)
			const result = await readProjectBooConfig(tmpDir)
			expect(result).toEqual({})
		})

		it("trims whitespace from drafting_profile value", async () => {
			await fs.writeFile(
				path.join(tmpDir, ".boo", "config.yaml"),
				`collaborate:\n  drafting_profile: "  opus-quality  "\n`,
			)
			const result = await readProjectBooConfig(tmpDir)
			expect(result).toEqual({ collaborate: { drafting_profile: "opus-quality" } })
		})
	})
})
