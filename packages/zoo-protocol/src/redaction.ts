const REDACTED = "[REDACTED]" as const
const sensitiveKeyName = String.raw`(?:[A-Za-z0-9_.-]*(?:password|secret|passphrase|passwd|pwd)[A-Za-z0-9_.-]*|[A-Za-z0-9_.-]*(?:api[-_. ]?(?:key|token)|access[-_. ]?token|auth[-_. ]?token|bearer[-_. ]?token|client[-_. ]?secret|id[-_. ]?token|private[-_. ]?key|refresh[-_. ]?token|session[-_. ]?token)|authorization|cookie|credentials?|token)`
const secretValue = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;}]+)`
const cliSecretValue = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;}]+)`
const doubleQuotedSecret = new RegExp(`("${sensitiveKeyName}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gi")
const singleQuotedSecret = new RegExp(`('${sensitiveKeyName}'\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`, "gi")
const quotedUnquotedSecret = new RegExp(
	`((?:"${sensitiveKeyName}"|'${sensitiveKeyName}')\\s*:\\s*)(?!["'])[^\\r\\n;}]+`,
	"gi",
)
const quotedAssignment = /((["'])([^"']+)\2\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n;}]+)/g
const bareColonAssignment = /(\b([A-Za-z][A-Za-z0-9_.-]*)\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n;}]+)/g
const bareEqualsAssignment = /(\b([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;}]+)/g
const terminalControl = new RegExp(
	`(?:${String.fromCharCode(27)}\\][^${String.fromCharCode(7)}${String.fromCharCode(27)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\)|${String.fromCharCode(27)}[PX^_][\\s\\S]*?${String.fromCharCode(27)}\\\\|${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]|[\\u0090\\u0098\\u009d\\u009e\\u009f][\\s\\S]*?\\u009c|\\u009b[0-?]*[ -/]*[@-~]|${String.fromCharCode(27)}[@-_])`,
	"g",
)
const unsafeTerminalEditing = new RegExp(
	`(?:${String.fromCharCode(27)}\\[[0-?]*[ -/]*[A-HJKSTfsu]|${String.fromCharCode(155)}[0-?]*[ -/]*[A-HJKSTfsu])`,
	"i",
)
const secretPatterns: ReadonlyArray<RegExp> = [
	/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+(?:\r?\n[ \t]+[^\r\n]*)*/gi,
	new RegExp(`--${sensitiveKeyName}(?:\\s*=\\s*|\\s+)${cliSecretValue}`, "gi"),
	new RegExp(`(?<!["'])\\b${sensitiveKeyName}\\s*:\\s*${secretValue}`, "gi"),
	new RegExp(`(?<!["'])\\b${sensitiveKeyName}\\s*=\\s*${cliSecretValue}`, "gi"),
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
	/\b(?:sk|xox[baprs]|gh[opusr])[-_][A-Za-z0-9_-]{8,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
	/\b[A-Za-z][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)\s*=\s*[^\s]+/gi,
	/-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g,
]

export type RedactedValue =
	| null
	| undefined
	| boolean
	| number
	| string
	| RedactedValue[]
	| { [key: string]: RedactedValue }
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export function isSensitiveKey(key: string): boolean {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[^A-Za-z0-9]+/g, " ")
		.trim()
		.toLowerCase()
	const compact = words.replace(/ /g, "")
	if (
		/\b(?:password|secret|passphrase|passwd|pwd)\b/.test(words) ||
		/^(?:(?:proxy )?authorization|credentials?)$/.test(words) ||
		/\bcookie\b/.test(words) ||
		/\bprivate key\b/.test(words)
	)
		return true
	if (/^[a-z0-9]+(?:password|secret|passphrase|passwd|pwd)$/.test(compact)) return true
	if (
		/^(?:.*)?(?:apikey|apitoken|accesstoken|authtoken|bearertoken|idtoken|privatekey|refreshtoken|sessiontoken)$/.test(
			compact,
		)
	) {
		return true
	}
	if (
		/\b(?:api key|api token|access token|auth token|bearer token|id token|private key|refresh token|session token) value$/.test(
			words,
		)
	) {
		return true
	}
	return /^(?:.* )?(?:api key|api token|access token|auth token|bearer token|id token|private key|refresh token|session token|token)$/.test(
		words,
	)
}

export function requiresFailClosedRedaction(value: string): boolean {
	if (unsafeTerminalEditing.test(value) || /(?:\r(?!\n)|[\v\f])/.test(value)) return true
	return [...value.matchAll(new RegExp(terminalControl.source, "g"))].some(([control]) =>
		containsSensitiveAssignment(control),
	)
}

function containsSensitiveAssignment(value: string): boolean {
	let candidateStart = 0
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index]!
		if (character === ":" || character === "=") {
			const candidate = value.slice(candidateStart, index).trim()
			if (candidate.length > 0 && isSensitiveKey(candidate)) return true
			candidateStart = index + 1
			continue
		}
		const code = character.charCodeAt(0)
		const allowed =
			(code >= 65 && code <= 90) ||
			(code >= 97 && code <= 122) ||
			(code >= 48 && code <= 57) ||
			character === "_" ||
			character === "." ||
			character === "-" ||
			character === " "
		if (!allowed) candidateStart = index + 1
	}
	return false
}

function redactAssignments(value: string): string {
	const isRedactedValue = (entry: string) => {
		const unquoted =
			(entry.startsWith('"') && entry.endsWith('"')) || (entry.startsWith("'") && entry.endsWith("'"))
				? entry.slice(1, -1)
				: entry
		return unquoted === REDACTED
	}
	const redactValueText = (prefix: string, entry: string) => {
		const quote =
			entry.startsWith('"') && entry.endsWith('"') ? '"' : entry.startsWith("'") && entry.endsWith("'") ? "'" : ""
		return `${prefix}${quote}${REDACTED}${quote}`
	}
	return value
		.replace(quotedAssignment, (match, prefix: string, _quote: string, key: string, value: string) =>
			isSensitiveKey(key) && !isRedactedValue(value) ? redactValueText(prefix, value) : match,
		)
		.replace(bareColonAssignment, (match, prefix: string, key: string, value: string) =>
			isSensitiveKey(key) && !isRedactedValue(value) ? redactValueText(prefix, value) : match,
		)
		.replace(bareEqualsAssignment, (match, prefix: string, key: string, value: string) =>
			isSensitiveKey(key) && !isRedactedValue(value) ? redactValueText(prefix, value) : match,
		)
}

export function canonicalizeRedactionText(value: string): string {
	const withoutTerminalControls = value
		.replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
		.replace(terminalControl, "")
	const rendered: string[] = []
	for (const character of withoutTerminalControls) {
		if (character === "\b") {
			if (rendered.at(-1) !== "\n") rendered.pop()
		} else {
			rendered.push(character)
		}
	}
	return rendered.join("")
}

export function redactText(value: string): string {
	if (requiresFailClosedRedaction(value)) return REDACTED
	const canonical = canonicalizeRedactionText(value)
	const structured = canonical
		.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#]+/g, (authority) => {
			const schemeEnd = authority.indexOf("//") + 2
			const credentialsEnd = authority.lastIndexOf("@")
			if (credentialsEnd < schemeEnd) return authority
			return `${authority.slice(0, schemeEnd)}${REDACTED}@${authority.slice(credentialsEnd + 1)}`
		})
		.replace(doubleQuotedSecret, `$1"${REDACTED}"`)
		.replace(singleQuotedSecret, `$1'${REDACTED}'`)
		.replace(quotedUnquotedSecret, `$1${REDACTED}`)
	const assignments = redactAssignments(structured)
	const redacted = secretPatterns.reduce((text, pattern) => text.replace(pattern, REDACTED), assignments)
	if (canonical !== value) return redacted === canonical ? value : REDACTED
	return redacted
}

export function createTextRedactor(maxBufferedLength = 16 * 1024) {
	let fragment = ""
	let logicalLine = ""
	let fragmentOverflowed = false
	let logicalOverflowed = false
	const flushLogicalLine = () => {
		if (!logicalLine && !logicalOverflowed) return ""
		const output = logicalOverflowed ? `${REDACTED}\n` : redactText(logicalLine)
		logicalLine = ""
		logicalOverflowed = false
		return output
	}
	const consume = (value: string, flush: boolean): string => {
		fragment += value
		let output = ""
		for (;;) {
			const newline = fragment.indexOf("\n")
			if (newline < 0) break
			const line = fragment.slice(0, newline + 1)
			fragment = fragment.slice(newline + 1)
			if (fragmentOverflowed) {
				output += flushLogicalLine()
				output += `${REDACTED}\n`
				fragmentOverflowed = false
			} else if (/^[ \t]/.test(line) && (logicalLine || logicalOverflowed)) {
				logicalLine += line
			} else {
				output += flushLogicalLine()
				logicalLine = line
			}
			if (logicalLine.length > maxBufferedLength) {
				logicalLine = ""
				logicalOverflowed = true
			}
		}
		if (fragment.length > maxBufferedLength) {
			fragment = ""
			fragmentOverflowed = true
		}
		if (flush) {
			output += flushLogicalLine()
			if (fragment || fragmentOverflowed) output += fragmentOverflowed ? REDACTED : redactText(fragment)
			fragment = ""
			fragmentOverflowed = false
		}
		return output
	}
	return {
		push: (value: string) => consume(value, false),
		flush: () => consume("", true),
	}
}

export function redactValue(value: Record<string, JsonValue>): Record<string, JsonValue>
export function redactValue(value: JsonValue[]): JsonValue[]
export function redactValue(value: JsonValue): JsonValue
export function redactValue(value: unknown, seen?: WeakSet<object>): RedactedValue
export function redactValue(value: unknown, seen = new WeakSet<object>()): RedactedValue {
	if (value === null || typeof value === "boolean" || typeof value === "number") return value
	if (value === undefined) return undefined
	if (typeof value === "string") return redactText(value)
	if (typeof value !== "object") return undefined
	if (seen.has(value)) return "[CIRCULAR]"
	seen.add(value)

	let result: RedactedValue
	if (Array.isArray(value)) {
		result = value.map((entry) => redactValue(entry, seen))
	} else {
		const entries: Record<string, RedactedValue> = {}
		for (const [key, entry] of Object.entries(value)) {
			Object.defineProperty(entries, key, {
				value: isSensitiveKey(key) ? REDACTED : redactValue(entry, seen),
				enumerable: true,
				configurable: true,
				writable: true,
			})
		}
		result = entries
	}
	seen.delete(value)
	return result
}

export { REDACTED }
