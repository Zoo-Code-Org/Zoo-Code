/**
 * @fileoverview Main entry point for the compact logging system
 * Provides a default logger instance with Jest environment detection
 */

import { CompactLogger } from "./CompactLogger"
import type { ILogger, LogLevel, LogMeta } from "./types"

/**
 * No-operation logger implementation, used until a transport is installed
 */
const noopLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	fatal: () => {},
	child: () => noopLogger,
	close: () => {},
}

/** Minimal surface of a VS Code OutputChannel, kept structural to avoid importing vscode here. */
export interface LogOutputChannel {
	appendLine(value: string): void
}

/**
 * Logger that writes human-readable lines to a VS Code output channel.
 */
export class OutputChannelLogger implements ILogger {
	constructor(
		private readonly channel: LogOutputChannel,
		private readonly meta: LogMeta = {},
	) {}

	private write(level: LogLevel, message: string | Error, meta?: LogMeta): void {
		const combined = { ...this.meta, ...meta }
		const { ctx, ...rest } = combined
		const parts = [`[${new Date().toISOString()}] ${level.toUpperCase()}`]
		if (ctx) {
			parts.push(`(${String(ctx)})`)
		}
		parts.push(message instanceof Error ? message.message : message)
		let line = parts.join(" ")

		if (message instanceof Error && message.stack) {
			line += `\n${message.stack}`
		}

		for (const [key, value] of Object.entries(rest)) {
			if (value === undefined) continue
			if (value instanceof Error) {
				line += `\n  ${key}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`
				continue
			}
			if (typeof value === "object" && value !== null) {
				try {
					line += `\n  ${key}: ${JSON.stringify(value)}`
				} catch {
					line += `\n  ${key}: [non-serializable]`
				}
				continue
			}
			line += `\n  ${key}: ${String(value)}`
		}

		this.channel.appendLine(line)
	}

	debug(message: string, meta?: LogMeta) {
		this.write("debug", message, meta)
	}
	info(message: string, meta?: LogMeta) {
		this.write("info", message, meta)
	}
	warn(message: string, meta?: LogMeta) {
		this.write("warn", message, meta)
	}
	error(message: string | Error, meta?: LogMeta) {
		this.write("error", message, meta)
	}
	fatal(message: string | Error, meta?: LogMeta) {
		this.write("fatal", message, meta)
	}
	child(meta: LogMeta): ILogger {
		return new OutputChannelLogger(this.channel, { ...this.meta, ...meta })
	}
	close() {}
}

/**
 * Active sink. Tests use the CompactLogger; shipped builds start as a no-op and
 * gain the output channel once the extension activates.
 */
let sink: ILogger = process.env.NODE_ENV === "test" ? new CompactLogger() : noopLogger

/**
 * Routes `logger` calls to the "Zoo Code" output channel so provider-layer
 * errors (which use `logger.error`, not `console.error`) become observable.
 */
export function initializeOutputChannelLogging(channel: LogOutputChannel): void {
	if (process.env.NODE_ENV === "test") {
		return
	}
	sink = new OutputChannelLogger(channel)
}

/**
 * Default logger instance. Stable reference that delegates to the active sink,
 * so modules can import it at load time and still pick up a later transport.
 */
export const logger: ILogger = {
	debug: (message, meta) => sink.debug(message, meta),
	info: (message, meta) => sink.info(message, meta),
	warn: (message, meta) => sink.warn(message, meta),
	error: (message, meta) => sink.error(message, meta),
	fatal: (message, meta) => sink.fatal(message, meta),
	child: (meta) => sink.child(meta),
	close: () => sink.close(),
}
