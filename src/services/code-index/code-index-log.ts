import { isMainThread, parentPort } from "node:worker_threads"

export type CodeIndexLogLevel = "info" | "warn" | "error" | "debug"
export interface CodeIndexLogConfiguration {
	workspacePaths?: readonly string[]
	secrets?: readonly string[]
}
export interface CodeIndexFailureDiagnostic {
	path: string
	activity: string
	reason: string
	attempt: number
	willRetry: boolean
	[key: string]: unknown
}

export type CodeIndexLogSink = Record<CodeIndexLogLevel, (message: string) => void> & { dispose(): void }

const redacted = "[REDACTED]"
const sensitiveField = /^(?:authorization|.*api[-_]?key|.*secret|.*password|.*token)$/i
const contentField =
	/^(?:content|contents|text|texts|input|inputs|body|request|response|data|embedding|embeddings|vectors)$/i
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
let workspacePattern: RegExp | undefined
let secretPattern: RegExp | undefined
let channel: CodeIndexLogSink | undefined
let hostSinkFactory: (() => CodeIndexLogSink) | undefined

function configure(configuration: CodeIndexLogConfiguration): void {
	if (configuration.workspacePaths !== undefined) {
		const roots = configuration.workspacePaths
			.filter(Boolean)
			.map((root) => root.replace(/[\\/]+$/, ""))
			.filter(Boolean)
			.sort((left, right) => right.length - left.length)
		workspacePattern = roots.length
			? new RegExp(
					`(?:${roots.map((root) => root.split(/[\\/]/).map(escapePattern).join("[\\\\/]")).join("|")})(?:[\\\\/]|(?=$|[\\s\"',:)]))`,
					"gi",
				)
			: undefined
	}
	if (configuration.secrets !== undefined) {
		const secrets = [...new Set(configuration.secrets.filter(Boolean))].sort(
			(left, right) => right.length - left.length,
		)
		secretPattern = secrets.length ? new RegExp(secrets.map(escapePattern).join("|"), "g") : undefined
	}
}

function redact(value: string): string {
	let result = value.replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/?#@]*@/gi, `$1${redacted}@`)
	result = result.replace(/\b(authorization|api[-_]?key)(["']?\s*[:=]\s*["']?)[^\r\n"',;}]+/gi, `$1$2${redacted}`)
	if (workspacePattern) result = result.replace(workspacePattern, "")
	if (secretPattern) result = result.replace(secretPattern, redacted)
	return result
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return redact(value)
	if (value === null || typeof value !== "object") return value
	if (seen.has(value)) return "[Circular]"
	seen.add(value)
	if (value instanceof Error) {
		// SDK errors can hold request bodies and credentials outside the message.
		const error = value as Error & {
			code?: unknown
			status?: unknown
			statusCode?: unknown
			classification?: unknown
		}
		return sanitize(
			{
				name: error.name,
				message: error.message,
				code: error.code,
				status: error.status,
				statusCode: error.statusCode,
				classification: error.classification,
			},
			seen,
		)
	}
	if (Array.isArray(value)) return value.map((entry) => sanitize(entry, seen))
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			redact(key),
			sensitiveField.test(key) || contentField.test(key) ? redacted : sanitize(entry, seen),
		]),
	)
}

function write(level: CodeIndexLogLevel, message: string, fields?: unknown): void {
	const safeMessage = redact(message)
	const safeFields = sanitize(fields)
	if (!isMainThread) {
		parentPort?.postMessage({ id: 0, diagnostic: { level, message: safeMessage, fields: safeFields } })
		return
	}
	channel ??= hostSinkFactory?.()
	if (!channel) return
	const suffix = safeFields === undefined ? "" : ` ${JSON.stringify(safeFields)}`
	channel[level](`[CodeIndex] ${safeMessage}${suffix}`)
}

function createFailureBatch(fields?: Record<string, unknown>) {
	let failures: CodeIndexFailureDiagnostic[] = []
	return {
		record(failure: CodeIndexFailureDiagnostic): void {
			failures.push({ ...failure })
		},
		flush(): void {
			if (failures.length === 0) return
			const completed = failures
			failures = []
			write("warn", "File operation failures", { ...fields, failureCount: completed.length, failures: completed })
		},
	}
}

export const codeIndexLog = {
	configure,
	setHostSinkFactory(factory: () => CodeIndexLogSink): void {
		if (hostSinkFactory === factory) return
		codeIndexLog.dispose()
		hostSinkFactory = factory
	},
	redact,
	createFailureBatch,
	info: (message: string, fields?: unknown) => write("info", message, fields),
	warn: (message: string, fields?: unknown) => write("warn", message, fields),
	error: (message: string, fields?: unknown) => write("error", message, fields),
	debug: (message: string, fields?: unknown) => write("debug", message, fields),
	dispose(): void {
		channel?.dispose()
		channel = undefined
	},
}
