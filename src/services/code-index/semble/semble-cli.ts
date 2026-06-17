import { spawn } from "child_process"

import { SembleSearchResult, SembleCheckResult, SembleContentType, SEMBLE_DEFAULTS } from "./types"

/**
 * Wraps the `semble` CLI for programmatic access.
 *
 * The semble binary is automatically downloaded on enablement via semble-downloader.ts.
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

	constructor(semblePath: string) {
		this.semblePath = semblePath
	}

	/**
	 * Checks whether the semble binary is functional by running `semble --help`.
	 */
	async checkInstalled(): Promise<SembleCheckResult> {
		try {
			await this._spawn(["--help"], { timeout: 10_000 })
			return { installed: true }
		} catch (error: any) {
			return {
				installed: false,
				error: error?.stderr?.trim() || error?.message || "Failed to run semble",
			}
		}
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
	 * Spawns the semble process and collects stdout/stderr.
	 * Uses spawn without shell — args are passed as an array, no injection risk.
	 * Caps stdout/stderr buffers at MAX_BUFFER_BYTES to prevent OOM in the extension host.
	 * Kills the process and rejects if the cap is exceeded.
	 */
	private _spawn(args: string[], options: { timeout: number }): Promise<{ stdout: string; stderr: string }> {
		const MAX_BUFFER_BYTES = 10 * 1024 * 1024 // 10 MB

		return new Promise((resolve, reject) => {
			const child = spawn(this.semblePath, args, {
				shell: false,
				timeout: options.timeout,
				stdio: ["ignore", "pipe", "pipe"],
			})

			let stdout = ""
			let stderr = ""
			let stdoutBytes = 0
			let stderrBytes = 0
			let killed = false

			child.stdout?.on("data", (data: Buffer) => {
				stdoutBytes += data.length
				if (stdoutBytes <= MAX_BUFFER_BYTES) {
					stdout += data.toString()
				} else if (!killed) {
					killed = true
					child.kill()
					reject({
						message: `stdout exceeded ${MAX_BUFFER_BYTES} bytes — process killed to protect extension host`,
						stderr,
					})
				}
			})

			child.stderr?.on("data", (data: Buffer) => {
				stderrBytes += data.length
				if (stderrBytes <= MAX_BUFFER_BYTES) {
					stderr += data.toString()
				} else if (!killed) {
					killed = true
					child.kill()
					reject({
						message: `stderr exceeded ${MAX_BUFFER_BYTES} bytes — process killed to protect extension host`,
						stderr,
					})
				}
			})

			child.on("error", (err: Error) => {
				if (!killed) {
					reject({ message: err.message, stderr })
				}
			})

			child.on("close", (code: number | null) => {
				if (killed) {
					return // already rejected
				}
				if (code === 0) {
					resolve({ stdout, stderr })
				} else {
					reject({ message: `Process exited with code ${code}`, stderr, stdout })
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
