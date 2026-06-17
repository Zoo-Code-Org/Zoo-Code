import { describe, it, expect, vi, beforeEach } from "vitest"
import { EventEmitter } from "events"
import { SembleCLI } from "../semble-cli"

// Mock spawn
const mockSpawn = vi.fn()

vi.mock("child_process", () => ({
	spawn: (...args: any[]) => mockSpawn(...args),
}))

/**
 * Helper to create a fake child process that emits stdout/stderr and closes.
 */
function createMockProcess(stdout: string, stderr: string, exitCode: number) {
	const proc = new EventEmitter() as any
	proc.stdout = new EventEmitter()
	proc.stderr = new EventEmitter()

	// Schedule data emission and close on next tick
	setImmediate(() => {
		if (stdout) proc.stdout.emit("data", Buffer.from(stdout))
		if (stderr) proc.stderr.emit("data", Buffer.from(stderr))
		proc.emit("close", exitCode)
	})

	return proc
}

/**
 * Helper to create a mock process that emits an error.
 */
function createErrorProcess(errorMessage: string) {
	const proc = new EventEmitter() as any
	proc.stdout = new EventEmitter()
	proc.stderr = new EventEmitter()

	setImmediate(() => {
		proc.emit("error", new Error(errorMessage))
	})

	return proc
}

describe("SembleCLI", () => {
	let cli: SembleCLI

	beforeEach(() => {
		vi.clearAllMocks()
		cli = new SembleCLI("semble")
	})

	describe("constructor", () => {
		it("should accept a path to the semble executable", () => {
			const customCli = new SembleCLI("/usr/local/bin/semble")
			expect(customCli).toBeDefined()
		})
	})

	describe("checkInstalled", () => {
		it("should return installed: true when --help succeeds", async () => {
			mockSpawn.mockReturnValueOnce(createMockProcess("usage: semble ...", "", 0))

			const result = await cli.checkInstalled()

			expect(result).toEqual({ installed: true })
			expect(mockSpawn).toHaveBeenCalledWith("semble", ["--help"], expect.objectContaining({ shell: false }))
		})

		it("should return installed: false when semble --help fails", async () => {
			mockSpawn.mockReturnValueOnce(createMockProcess("", "semble: command not found", 127))

			const result = await cli.checkInstalled()

			expect(result.installed).toBe(false)
			expect(result.error).toContain("semble: command not found")
		})

		it("should return installed: false on spawn error", async () => {
			mockSpawn.mockReturnValueOnce(createErrorProcess("spawn ENOENT"))

			const result = await cli.checkInstalled()

			expect(result.installed).toBe(false)
			expect(result.error).toContain("spawn ENOENT")
		})
	})

	describe("search", () => {
		it("should spawn with array args (no shell)", async () => {
			const jsonResponse = JSON.stringify({ query: "auth", results: [] })
			mockSpawn.mockReturnValue(createMockProcess(jsonResponse, "", 0))

			await cli.search("authentication", "/path/to/repo")

			expect(mockSpawn).toHaveBeenCalledWith(
				"semble",
				["search", "authentication", "/path/to/repo", "-k", "10"],
				expect.objectContaining({ shell: false }),
			)
		})

		it("should pass special characters safely in query (no shell interpretation)", async () => {
			const jsonResponse = JSON.stringify({ query: "test", results: [] })
			mockSpawn.mockReturnValue(createMockProcess(jsonResponse, "", 0))

			await cli.search('test $(rm -rf /) `whoami` "injection"', "/repo")

			// With spawn (no shell), these are just string args — not interpreted
			expect(mockSpawn).toHaveBeenCalledWith(
				"semble",
				["search", 'test $(rm -rf /) `whoami` "injection"', "/repo", "-k", "10"],
				expect.objectContaining({ shell: false }),
			)
		})

		it("should build correct args with custom topK", async () => {
			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify({ query: "test", results: [] }), "", 0))

			await cli.search("test", "/repo", { topK: 5 })

			expect(mockSpawn).toHaveBeenCalledWith("semble", ["search", "test", "/repo", "-k", "5"], expect.any(Object))
		})

		it("should add --content flag for non-default content types", async () => {
			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify({ query: "test", results: [] }), "", 0))

			await cli.search("test", "/repo", { content: "all" })

			expect(mockSpawn).toHaveBeenCalledWith(
				"semble",
				["search", "test", "/repo", "-k", "10", "--content", "all"],
				expect.any(Object),
			)
		})

		it("should not add --content flag for code (default)", async () => {
			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify({ query: "test", results: [] }), "", 0))

			await cli.search("test", "/repo", { content: "code" })

			expect(mockSpawn).toHaveBeenCalledWith(
				"semble",
				["search", "test", "/repo", "-k", "10"],
				expect.any(Object),
			)
		})

		it("should throw error when semble search fails", async () => {
			mockSpawn.mockReturnValue(createMockProcess("", "Error: something went wrong", 1))

			await expect(cli.search("test", "/repo")).rejects.toThrow("Semble search failed")
		})
	})

	describe("findRelated", () => {
		it("should build correct args with default options", async () => {
			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify({ query: "related", results: [] }), "", 0))

			await cli.findRelated("src/auth.ts", 42, "/repo")

			expect(mockSpawn).toHaveBeenCalledWith(
				"semble",
				["find-related", "src/auth.ts", "42", "/repo", "-k", "10"],
				expect.any(Object),
			)
		})

		it("should build correct args with custom topK and content", async () => {
			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify({ query: "related", results: [] }), "", 0))

			await cli.findRelated("src/auth.ts", 42, "/repo", { topK: 3, content: "all" })

			expect(mockSpawn).toHaveBeenCalledWith(
				"semble",
				["find-related", "src/auth.ts", "42", "/repo", "-k", "3", "--content", "all"],
				expect.any(Object),
			)
		})

		it("should not add --content flag for code (default)", async () => {
			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify({ query: "related", results: [] }), "", 0))

			await cli.findRelated("src/auth.ts", 42, "/repo", { content: "code" })

			expect(mockSpawn).toHaveBeenCalledWith(
				"semble",
				["find-related", "src/auth.ts", "42", "/repo", "-k", "10"],
				expect.any(Object),
			)
		})

		it("should add --content flag for docs content type", async () => {
			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify({ query: "related", results: [] }), "", 0))

			await cli.findRelated("src/auth.ts", 42, "/repo", { content: "docs" })

			expect(mockSpawn).toHaveBeenCalledWith(
				"semble",
				["find-related", "src/auth.ts", "42", "/repo", "-k", "10", "--content", "docs"],
				expect.any(Object),
			)
		})

		it("should throw error when semble find-related fails", async () => {
			mockSpawn.mockReturnValue(createMockProcess("", "Error: no chunk found", 1))

			await expect(cli.findRelated("src/auth.ts", 42, "/repo")).rejects.toThrow("Semble find-related failed")
		})

		it("should throw with message when find-related fails with empty stderr", async () => {
			mockSpawn.mockReturnValue(createMockProcess("", "", 1))

			await expect(cli.findRelated("src/auth.ts", 42, "/repo")).rejects.toThrow("Semble find-related failed")
		})

		it("should parse results from find-related", async () => {
			const jsonResponse = {
				query: "related",
				results: [
					{
						chunk: {
							content: "related code",
							file_path: "src/related.ts",
							start_line: 1,
							end_line: 10,
							language: "typescript",
							location: "src/related.ts:1-10",
						},
						score: 0.85,
					},
				],
			}
			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify(jsonResponse), "", 0))

			const results = await cli.findRelated("src/auth.ts", 42, "/repo")

			expect(results).toHaveLength(1)
			expect(results[0].chunk.file_path).toBe("src/related.ts")
			expect(results[0].score).toBe(0.85)
		})
	})

	describe("_parseOutput (via search)", () => {
		it("should parse v0.3.0+ JSON format with nested chunk", async () => {
			const jsonResponse = {
				query: "authentication",
				results: [
					{
						chunk: {
							content: "function authenticate() {}",
							file_path: "src/auth.ts",
							start_line: 10,
							end_line: 25,
							language: "typescript",
							location: "src/auth.ts:10-25",
						},
						score: 0.92,
					},
					{
						chunk: {
							content: "export function login() {}",
							file_path: "src/login.ts",
							start_line: 5,
							end_line: 15,
							language: "typescript",
							location: "src/login.ts:5-15",
						},
						score: 0.78,
					},
				],
			}

			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify(jsonResponse), "", 0))

			const results = await cli.search("authentication", "/repo")

			expect(results).toHaveLength(2)
			expect(results[0].chunk.file_path).toBe("src/auth.ts")
			expect(results[0].chunk.start_line).toBe(10)
			expect(results[0].chunk.end_line).toBe(25)
			expect(results[0].chunk.content).toBe("function authenticate() {}")
			expect(results[0].score).toBe(0.92)
			expect(results[1].chunk.file_path).toBe("src/login.ts")
			expect(results[1].score).toBe(0.78)
		})

		it("should handle empty results response", async () => {
			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify({ query: "nonexistent", results: [] }), "", 0))

			const results = await cli.search("nonexistent", "/repo")

			expect(results).toEqual([])
		})

		it("should handle error response from semble", async () => {
			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify({ error: "No results found." }), "", 0))

			const results = await cli.search("nonexistent", "/repo")

			expect(results).toEqual([])
		})

		it("should handle empty stdout", async () => {
			mockSpawn.mockReturnValue(createMockProcess("", "", 0))

			const results = await cli.search("test", "/repo")

			expect(results).toEqual([])
		})

		it("should handle whitespace-only stdout", async () => {
			mockSpawn.mockReturnValue(createMockProcess("   \n  \n  ", "", 0))

			const results = await cli.search("test", "/repo")

			expect(results).toEqual([])
		})

		it("should handle non-JSON output gracefully", async () => {
			mockSpawn.mockReturnValue(createMockProcess("Some plain text output that is not JSON", "", 0))

			const results = await cli.search("test", "/repo")

			expect(results).toEqual([])
		})

		it("should handle flat array format (older semble format)", async () => {
			const flatArray = [
				{
					chunk: {
						content: "old format result",
						file_path: "src/old.ts",
						start_line: 1,
						end_line: 5,
						language: "typescript",
						location: "src/old.ts:1-5",
					},
					score: 0.7,
				},
			]
			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify(flatArray), "", 0))

			const results = await cli.search("test", "/repo")

			expect(results).toHaveLength(1)
			expect(results[0].chunk.file_path).toBe("src/old.ts")
			expect(results[0].score).toBe(0.7)
		})

		it("should return empty array for unexpected JSON structure", async () => {
			mockSpawn.mockReturnValue(createMockProcess(JSON.stringify({ unexpected: "format" }), "", 0))

			const results = await cli.search("test", "/repo")

			expect(results).toEqual([])
		})
	})

	describe("search error handling", () => {
		it("should include stderr in error message when available", async () => {
			mockSpawn.mockReturnValue(createMockProcess("", "Permission denied: /repo", 1))

			await expect(cli.search("test", "/repo")).rejects.toThrow("Permission denied: /repo")
		})

		it("should fall back to process exit message when stderr is empty", async () => {
			mockSpawn.mockReturnValue(createMockProcess("", "", 1))

			await expect(cli.search("test", "/repo")).rejects.toThrow("Semble search failed")
		})

		it("should handle spawn error during search", async () => {
			mockSpawn.mockReturnValue(createErrorProcess("EACCES: permission denied"))

			await expect(cli.search("test", "/repo")).rejects.toThrow("EACCES: permission denied")
		})
	})
})
