import { spawn } from "child_process"

import { SembleSearchResult, SembleCheckResult, SembleContentType, SEMBLE_DEFAULTS } from "./types"

/**
 * Wraps the `semble` CLI for programmatic access.
 *
 * Semble must be installed via pip: `pip install semble`
 * The semblePath should be a direct path to the executable (e.g. "semble" or "/usr/local/bin/semble").
 *
 * All methods spawn the semble process via child_process.spawn with array
 * arguments (no shell) to prevent shell injection.
 *
 * Semble CLI (v0.3.0+) subcommands:
 *   search <query> [path]             — search a codebase
 *   find-related <file> <line> [path] — find similar code
 *   init                               — write sub-agent file
 *   savings                            — show token stats
 *
 * Common flags:
 *   -k, --top-k N                      — number of results (default: 5)
 *   --content TYPE [TYPE ...]          — content types: code, docs, config, all
 */
export class SembleCLI {
	private readonly semblePath: string

	constructor(semblePath: string = SEMBLE_DEFAULTS.DEFAULT_PATH) {
		this.semblePath = semblePath
	}

	/**
	 * Checks whether semble is installed and meets the minimum version requirement (0.3.0).
	 *
	 * - Confirms the executable runs via `semble --help`.
	 * - Queries `pip show semble` (falling back to `pip3`) to get the installed version
	 *   and validates >= 0.3.0.
	 */
	async checkInstalled(): Promise<SembleCheckResult> {
		// 1. Confirm the executable is runnable
		try {
			await this._spawn(["--help"], { timeout: 10_000 })
		} catch (error: any) {
			return {
				installed: false,
				error: error?.stderr?.trim() || error?.message || "Failed to run semble",
			}
		}

		// 2. Query pip for the installed semble version
		const version = await this._getPipVersion()
		if (!version) {
			// pip couldn't find it — semble may be installed outside pip, allow it
			return { installed: true, version: "unknown" }
		}

		// 3. Validate >= 0.3.0
		const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
		if (!match) {
			return { installed: true, version: "unknown" }
		}

		const [major, minor] = [Number(match[1]), Number(match[2])]
		if (major === 0 && minor < 3) {
			return {
				installed: false,
				error: `Semble version ${version} is not supported. Please upgrade to semble >= 0.3.0 (run: pip install --upgrade semble).`,
			}
		}

		return { installed: true, version }
	}

	/**
	 * Searches a codebase. Semble indexes on-the-fly during search.
	 *
	 * Usage: semble search <query> [path] [-k N] [--content TYPE [TYPE ...]]
	 */
	async search(
		query: string,
		repoPath: string,
		options?: { topK?: number; content?: SembleContentType },
	): Promise<SembleSearchResult[]> {
		const topK = options?.topK ?? SEMBLE_DEFAULTS.DEFAULT_TOP_K
		const args = ["search", query, repoPath, "-k", String(topK)]
		if (options?.content && options.content !== "code") {
			args.push("--content", options.content)
		}

		try {
			const { stdout } = await this._spawn(args, { timeout: 120_000 })
			return this._parseOutput(stdout)
		} catch (error: any) {
			const stderr = error?.stderr?.trim() || ""
			const message = error?.message || String(error)
			throw new Error(`Semble search failed: ${stderr || message}`)
		}
	}

	/**
	 * Finds code similar to a known location.
	 *
	 * Usage: semble find-related <file_path> <line> [path] [-k N] [--content TYPE [TYPE ...]]
	 */
	async findRelated(
		filePath: string,
		line: number,
		repoPath: string,
		options?: { topK?: number; content?: SembleContentType },
	): Promise<SembleSearchResult[]> {
		const topK = options?.topK ?? SEMBLE_DEFAULTS.DEFAULT_TOP_K
		const args = ["find-related", filePath, String(line), repoPath, "-k", String(topK)]
		if (options?.content && options.content !== "code") {
			args.push("--content", options.content)
		}

		try {
			const { stdout } = await this._spawn(args, { timeout: 120_000 })
			return this._parseOutput(stdout)
		} catch (error: any) {
			const stderr = error?.stderr?.trim() || ""
			const message = error?.message || String(error)
			throw new Error(`Semble find-related failed: ${stderr || message}`)
		}
	}

	/**
	 * Queries `pip show semble` (falling back to `pip3`) and returns the version string,
	 * or `undefined` if semble is not found in pip or pip is unavailable.
	 */
	private async _getPipVersion(): Promise<string | undefined> {
		for (const pipCmd of ["pip", "pip3"]) {
			try {
				const stdout = await this._spawnExternal(pipCmd, ["show", "semble"], { timeout: 10_000 })
				// pip show outputs lines like "Version: 0.3.1"
				const match = stdout.match(/^Version:\s*(.+)$/m)
				if (match) {
					return match[1].trim()
				}
			} catch {
				// try next
			}
		}
		return undefined
	}

	/**
	 * Spawns the semble process and collects stdout/stderr.
	 * Uses spawn without shell — args are passed as an array, no injection risk.
	 */
	private _spawn(args: string[], options: { timeout: number }): Promise<{ stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.semblePath, args, {
				shell: false,
				timeout: options.timeout,
				maxBuffer: 10 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			} as any)

			let stdout = ""
			let stderr = ""

			child.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString()
			})

			child.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString()
			})

			child.on("error", (err: Error) => {
				reject({ message: err.message, stderr })
			})

			child.on("close", (code: number | null) => {
				if (code === 0) {
					resolve({ stdout, stderr })
				} else {
					reject({ message: `Process exited with code ${code}`, stderr, stdout })
				}
			})
		})
	}

	/**
	 * Spawns an arbitrary external command (not the semble executable) and returns stdout.
	 */
	private _spawnExternal(cmd: string, args: string[], options: { timeout: number }): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn(cmd, args, {
				shell: false,
				timeout: options.timeout,
				stdio: ["ignore", "pipe", "pipe"],
			} as any)

			let stdout = ""
			let stderr = ""

			child.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString()
			})
			child.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString()
			})
			child.on("error", (err: Error) => {
				reject({ message: err.message, stderr })
			})
			child.on("close", (code: number | null) => {
				if (code === 0) {
					resolve(stdout)
				} else {
					reject({ message: `Process exited with code ${code}`, stderr })
				}
			})
		})
	}

	/**
	 * Parses semble CLI JSON output into structured results.
	 *
	 * Semble v0.3.0+ outputs JSON by default with format:
	 *   { "query": "...", "results": [{ "chunk": { "content": "...", "file_path": "...", "start_line": N, "end_line": M, "language": "...", "location": "..." }, "score": X }] }
	 *
	 * If the query returns no results, semble outputs:
	 *   { "error": "No results found." }
	 */
	private _parseOutput(stdout: string): SembleSearchResult[] {
		const trimmed = stdout.trim()
		if (!trimmed) {
			return []
		}

		try {
			const parsed = JSON.parse(trimmed)

			// Handle error response: {"error": "No results found."}
			if (parsed.error) {
				return []
			}

			// Handle successful response: {query, results: [{chunk, score}]}
			if (parsed.results && Array.isArray(parsed.results)) {
				return parsed.results as SembleSearchResult[]
			}

			// Fallback: if it's a flat array (older format)
			if (Array.isArray(parsed)) {
				return parsed as SembleSearchResult[]
			}

			return []
		} catch {
			// Not JSON — this shouldn't happen with v0.3.0+ but handle gracefully
			console.warn("[SembleCLI] Unexpected non-JSON output from semble")
			return []
		}
	}
}
