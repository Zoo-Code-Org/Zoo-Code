/**
 * Super Debug Logger — central debug mechanism for Zoo-Code
 *
 * Writes to two log files in the user's project root:
 *   1. {cwd}/crt-debug.log     — CRT logs (Content Reference Tool)
 *   2. {cwd}/debug-log/zoo-debug.log — system log for ALL components
 *
 * Control:
 *   - VSCode setting: zoo-code.debug = true/false
 *   - Environment variable: ZOO_DEBUG=1
 *   - Programmatic: ZooDebug.setEnabled(true)
 *
 * Log levels (always written to file when enabled):
 *   info    — informational messages (all calls, steps)
 *   warn    — warnings + console.warn
 *   error   — errors + console.error
 *
 * CRT-specific methods (write to both files):
 *   call()    — tool invocation
 *   crt()     — CRT message
 *   success() — successful ref resolution
 *   execute() — tool execution
 */

import * as fs from "fs"
import * as path from "path"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let enabled = false
let initialized = false
let debugLogPath: string | null = null
let crtLogPath: string | null = null

// ---------------------------------------------------------------------------
// Console interceptors (save originals for restore)
// ---------------------------------------------------------------------------

const consoleOriginal = {
	log: console.log,
	warn: console.warn,
	error: console.error,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function writeFile(logPath: string | null, prefix: string, context: string, message: string, data?: unknown): void {
	if (!logPath || !enabled) return
	try {
		const timestamp = new Date().toISOString()
		const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : ""
		const line = `[${timestamp}] [${prefix}] [${context}] ${message}${dataStr}\n`
		fs.appendFileSync(logPath, line, "utf8")
	} catch {
		// Silent fail — logging should never break the app
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the super-logger.
 * Called once when a task starts (from Task.ts or BaseTool.ts).
 *
 * @param cwd  — project root (task.cwd)
 * @param flag — enable logging (true=on)
 */
export function initDebugLog(cwd: string, flag: boolean): void {
	if (initialized) return
	initialized = true
	enabled = flag
	if (!enabled) return

	try {
		// Create debug-log/ directory
		const logDir = path.join(cwd, "debug-log")
		fs.mkdirSync(logDir, { recursive: true })

		debugLogPath = path.join(logDir, "zoo-debug.log")
		crtLogPath = path.join(cwd, "crt-debug.log")

		// Session markers
		const sessionLine = `[${new Date().toISOString()}] [SESSION] === ZOO-DEBUG SESSION STARTED ===\n`
		fs.appendFileSync(debugLogPath, sessionLine, "utf8")
		fs.appendFileSync(crtLogPath, sessionLine, "utf8")

		// Patch console.log/warn/error — all console.* calls go to zoo-debug.log
		console.log = (...args: unknown[]) => {
			consoleOriginal.log(...args)
			writeFile(debugLogPath, "CONSOLE:LOG", "", args.map((a) => String(a)).join(" "))
		}
		console.warn = (...args: unknown[]) => {
			consoleOriginal.warn(...args)
			writeFile(debugLogPath, "CONSOLE:WARN", "", args.map((a) => String(a)).join(" "))
		}
		console.error = (...args: unknown[]) => {
			consoleOriginal.error(...args)
			writeFile(debugLogPath, "CONSOLE:ERROR", "", args.map((a) => String(a)).join(" "))
		}

		info("SUPER-DEBUG", "Session started", { cwd, debugLogPath, crtLogPath })
	} catch (err) {
		// If we can't even create the log directory, disable silently
		enabled = false
		initialized = false
		consoleOriginal.error("[ZooDebug] Failed to initialize:", err)
	}
}

/**
 * Enable/disable logging on the fly.
 */
export function setDebugEnabled(flag: boolean): void {
	enabled = flag
}

/**
 * Current logger state.
 */
export function isDebugEnabled(): boolean {
	return enabled
}

/**
 * Restore original console.* methods (for tests).
 */
export function restoreConsole(): void {
	console.log = consoleOriginal.log
	console.warn = consoleOriginal.warn
	console.error = consoleOriginal.error
}

// ---------------------------------------------------------------------------
// Logging methods
// ---------------------------------------------------------------------------

/**
 * Informational message — written to zoo-debug.log.
 * Always writes if logging is enabled (info level).
 */
export function info(context: string, message: string, data?: unknown): void {
	writeFile(debugLogPath, "INFO", context, message, data)
}

/**
 * Warning — written to zoo-debug.log + console.warn.
 */
export function warn(context: string, message: string, data?: unknown): void {
	consoleOriginal.warn(`[${context}] ${message}`, data)
	writeFile(debugLogPath, "WARN", context, message, data)
}

/**
 * Error — written to zoo-debug.log + console.error.
 */
export function error(context: string, message: string, data?: unknown): void {
	consoleOriginal.error(`[${context}] ${message}`, data)
	writeFile(debugLogPath, "ERROR", context, message, data)
}

// ---------------------------------------------------------------------------
// CRT-specific methods (write to BOTH files)
// ---------------------------------------------------------------------------

/**
 * CRT tool invocation — written to crt-debug.log + zoo-debug.log.
 * Matches the [CALL] format from the documented protocol.
 */
export function callCrt(context: string, toolName: string, params?: unknown): void {
	writeFile(debugLogPath, "CRT:CALL", context, `${toolName}`, params)
	writeFile(crtLogPath, "CALL", context, `${toolName}`, params)
}

/**
 * CRT message — written to crt-debug.log + zoo-debug.log.
 */
export function logCrt(context: string, message: string, data?: unknown): void {
	writeFile(debugLogPath, "CRT", context, message, data)
	writeFile(crtLogPath, "CRT", context, message, data)
}

/**
 * Successful ref resolution — written to crt-debug.log + zoo-debug.log.
 * Matches the [SUCCESS] format.
 */
export function successCrt(context: string, detail: string, data?: unknown): void {
	writeFile(debugLogPath, "CRT:SUCCESS", context, detail, data)
	writeFile(crtLogPath, "SUCCESS", context, detail, data)
}

/**
 * Tool execution with ref — written to crt-debug.log + zoo-debug.log.
 * Matches the [EXECUTE] format.
 */
export function executeCrt(context: string, detail: string, data?: unknown): void {
	writeFile(debugLogPath, "CRT:EXECUTE", context, detail, data)
	writeFile(crtLogPath, "EXECUTE", context, detail, data)
}
