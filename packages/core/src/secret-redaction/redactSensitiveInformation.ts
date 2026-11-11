// Credential key names, as one regex alternation. Keys with a prefix or suffix match too (DB_PASSWORD, npmToken).
const CREDENTIAL_KEYWORDS =
	"api[_-]?key|access[_-]?key(?:[_-]?id)?|token|auth|client[_-]?secret|private[_-]?key|secret(?:[_-]?(?:access[_-]?)?key)?|passw(?:or)?d|passphrase|pwd|credentials?"

// `\x60` is a backtick. An assignment operator not followed by `=` or `>` skips comparisons
// (`password === x`) and arrow functions. Only spaces and tabs may surround it, so a key at the end of
// a line (a YAML mapping such as `credentials:`) never takes the next line as its value.
const ASSIGNMENT = String.raw`["'\x60]?[ \t]*[:=](?![=>])[ \t]*`
// A quoted value runs to its closing quote, so `;` or `,` inside the quotes is redacted too.
// Backslash escapes are honored. Empty quotes are left alone.
const QUOTED_VALUE = String.raw`(?<open>["'\x60])(?:\\.|(?!\k<open>)[^\\\n])+\k<open>`
// An unquoted (or unterminated) value runs to the end of the line, so a value with spaces
// (`passphrase: correct horse battery staple`) is redacted completely.
const UNQUOTED_VALUE = String.raw`["'\x60]?[^\s"'\x60][^\n]*`
const AUTH_SCHEME = String.raw`(?:Bearer|Basic|Digest|Token)[ \t]+`
// A value under a credential key is always redacted, whatever its shape: casing or syntax cannot tell a
// secret from code. The only exception is a type declaration such as `token: string;`: the rest of the
// line is a primitive type name or a union of them (`string | undefined`), optionally followed by `[]`
// and `,`, `;`, `)`, and an opening `{` or `:` (`(token: string) {`). Such a value can
// never be a secret. Anything more on the line (`string=abc`, `string abc`) is redacted.
const PRIMITIVE_TYPE = String.raw`&?(?:string|number|boolean|bigint|symbol|object|unknown|any|never|void|undefined|null|none|true|false|str|int|float|bool|bytes)(?:\[\])*`
const PRIMITIVE_TYPE_VALUE = String.raw`${PRIMITIVE_TYPE}(?:[ \t]*\|[ \t]*${PRIMITIVE_TYPE})*[,;)]*(?:[ \t]*[{:])?[ \t\r]*(?=\n|$)`

// Replacement for patterns that keep the key name and quotes and replace only the value.
const REDACTED_VALUE = "$<prefix>$<open>[REDACTED]$<open>"
// PEM private key blocks
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
// Authorization header values, with or without a scheme ("Authorization: Basic dXNlcjpwYXNz")
const AUTHORIZATION_HEADER = new RegExp(
	String.raw`(?<prefix>\bauthorization${ASSIGNMENT})(?:(?<open>["'\x60])(?<scheme>${AUTH_SCHEME})?(?:\\.|(?!\k<open>)[^\\\n])+\k<open>|(?<bareScheme>${AUTH_SCHEME})?${UNQUOTED_VALUE})`,
	"gi",
)
// Bearer tokens outside an Authorization header, in any case and of any length (RFC 6750 sets no
// minimum). The word after "Bearer" is always redacted: no shape test can tell a token from a word,
// and a redacted word in prose ("Bearer [REDACTED]") costs little.
const BEARER_TOKEN = /(?<prefix>\bbearer[ \t]+)[A-Za-z0-9_\-.~+/]+=*/gi
// Cookie headers carry session tokens and can hold spaces ("Cookie: a=1; b=2"), so the whole
// header value is redacted up to the end of the line.
const COOKIE_HEADER = new RegExp(
	String.raw`(?<prefix>\b(?:set-)?cookie${ASSIGNMENT})(?:${QUOTED_VALUE}|(?!${PRIMITIVE_TYPE_VALUE})[^\s][^\n]*)`,
	"gi",
)
// key = value, key: value, "key": "value" (env files, YAML, JSON, code). The key has no leading
// boundary, so prefixed and camelCase names match too (NPM_TOKEN, npmToken, DB_PASSWORD).
const CREDENTIAL_KEY_VALUE = new RegExp(
	String.raw`(?<prefix>(?:${CREDENTIAL_KEYWORDS})${ASSIGNMENT})(?:${QUOTED_VALUE}|(?!${PRIMITIVE_TYPE_VALUE})${UNQUOTED_VALUE})`,
	"gi",
)
// Well-known token formats that can appear without a key name
const BARE_TOKEN =
	/\b(?:sk-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{36,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{30,}|ya29\.[A-Za-z0-9_-]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g
// Webhook URLs carry their secret in the path. Scheme and host are case-insensitive (RFC 3986).
const WEBHOOK_URL =
	/(?<prefix>https:\/\/(?:hooks\.slack\.com\/services|(?:discord|discordapp)\.com\/api\/webhooks)\/)[^\s"'\x60)]+/gi
// Credentials embedded in URLs: scheme://user:password@host. The user may be empty
// (`redis://:password@host`), and the password may contain `@`: the value runs to the last `@` before the host.
const URL_CREDENTIALS = /(?<prefix>:\/\/[^\s:@/]*:)[^\s/]+(?=@)/g

/**
 * Each entry replaces one class of sensitive value. Patterns with a `prefix` capture group keep the
 * prefix (key name, header scheme, quotes) and replace only the value, so the model still sees which
 * setting changed. The order matters: header schemes run before the generic key/value pattern, and
 * URL credentials run before the email scan. A named group that did not take part in the match is
 * replaced with an empty string.
 */
const REDACTION_RULES: ReadonlyArray<[RegExp, string]> = [
	[PEM_PRIVATE_KEY, "[REDACTED_SECRET]"],
	[AUTHORIZATION_HEADER, "$<prefix>$<open>$<scheme>$<bareScheme>[REDACTED]$<open>"],
	[BEARER_TOKEN, "$<prefix>[REDACTED]"],
	[COOKIE_HEADER, REDACTED_VALUE],
	[CREDENTIAL_KEY_VALUE, REDACTED_VALUE],
	[BARE_TOKEN, "[REDACTED_SECRET]"],
	[WEBHOOK_URL, "$<prefix>[REDACTED]"],
	[URL_CREDENTIALS, "$<prefix>[REDACTED]"],
]

const EMAIL_LOCAL_PART_CHAR = /[A-Za-z0-9._%+-]/
const EMAIL_DOMAIN = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/y

/**
 * Replaces email addresses with [REDACTED_EMAIL] in linear time.
 *
 * An unanchored `local@domain` regex rescans a long run of local-part characters from every start
 * position when the run has no `@`, which is quadratic on a large diff. This scan starts at each `@`
 * instead. The local part is read backwards and stops at the end of the previous replacement or at
 * the previous `@`, so every character is visited a constant number of times. Back-to-back addresses
 * such as `a@b.co+c@d.co` are both replaced.
 */
function redactEmailAddresses(content: string): string {
	let result = ""
	let copiedUpTo = 0
	let at = content.indexOf("@")
	while (at !== -1) {
		let start = at
		while (start > copiedUpTo && EMAIL_LOCAL_PART_CHAR.test(content.charAt(start - 1))) {
			start--
		}
		EMAIL_DOMAIN.lastIndex = at + 1
		const domain = start < at ? EMAIL_DOMAIN.exec(content) : null
		if (domain) {
			result += content.slice(copiedUpTo, start) + "[REDACTED_EMAIL]"
			copiedUpTo = at + 1 + domain[0].length
			at = content.indexOf("@", copiedUpTo)
		} else {
			at = content.indexOf("@", at + 1)
		}
	}
	return result + content.slice(copiedUpTo)
}

const YAML_BLOCK_INDICATOR = /^[|>][-+0-9]*(?:[ \t]+#[^\n]*)?[ \t\r]*$/
const YAML_ITEM_START = /^[ \t]*-[ \t]+/
const YAML_KEY_LINE = /^[ \t]*(?:-[ \t]+)?(?:"[^"\n]*"|'[^'\n]*'|[^\s:#"'][^:#\n]*?)[ \t]*:(?:[ \t]|$)/
// A key named after a credential (`password:`), and the `name:` of a credential pair (`name: DB_PASSWORD`)
const YAML_CREDENTIAL_KEY = new RegExp(
	String.raw`^[ \t]*(?:-[ \t]+)?["']?[^"'\n:#]{0,256}?(?:${CREDENTIAL_KEYWORDS})[^"'\n:#]{0,256}["']?[ \t]*:[ \t]*`,
	"i",
)
const YAML_CREDENTIAL_NAME = new RegExp(
	String.raw`^[ \t]*(?:-[ \t]+)?["']?name["']?[ \t]*:[ \t]*["']?[^"'\n]{0,256}?(?:${CREDENTIAL_KEYWORDS})`,
	"i",
)
const YAML_VALUE_KEY = /^[ \t]*(?:-[ \t]+)?["']?value["']?[ \t]*:[ \t]*/i
const DIFF_HEADER = /^(?:diff --git |@@ )/
// Files with generic types (`Promise<Token>`). There, an XML credential element must close to count.
const CODE_FILE = /\.(?:[cm]?[jt]sx?|java|kts?|cs|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|swift|scala|dart|fs|vb)$/i
const XML_CREDENTIAL_NAME = new RegExp(String.raw`^[\w.:-]*(?:${CREDENTIAL_KEYWORDS})[\w.:-]*$`, "i")
const XML_MARKUP = /<!\[CDATA\[|<!--|<(\/?)([\w.:-]+)/gi
const CREDENTIAL_WORD = new RegExp(CREDENTIAL_KEYWORDS, "i")
// A `name`, `key` or `value` field of a record and its quoted or bare value
const RECORD_FIELD = new RegExp(
	String.raw`["']?(?:name|key|(?<valueKey>value))["']?[ \t]*[:=](?![=>])[ \t]*(?:(?<quote>["'])(?<quoted>(?:\\.|(?!\k<quote>)[^\\\n])*)\k<quote>|(?<bare>[^\s"'\x60,;{}<>\[][^\n,;{}<>]*))`,
	"iy",
)
// A quoted string up to its closing quote or the end of the line
const RECORD_STRING = /(["'\x60])(?:\\[^\n]|(?!\1)[^\\\n])*(?:\1|\\?(?=\n|$))/y
// `{`, or `<` and a tag name after a non-word character (`a<b` and `List<Token>` open no record)
const RECORD_OPENER = /\{|(?<!\w)<[A-Za-z_][\w.:-]*/y
// A credential key right before a record: `"password": {`, `auth = [{`
const CREDENTIAL_KEY_BEFORE = new RegExp(String.raw`(?:${CREDENTIAL_KEYWORDS})[\w.-]*["']?\s*[:=][\s[]*$`, "i")

type LineEntry = { i: number; prefix: number; text: string }
type AddEdit = (line: number, from: number, to: number) => void

/** Each line of one diff side (context lines and the side's `-` or `+` lines) with its prefix length. */
function sideLines(lines: string[], side: "-" | "+"): LineEntry[] {
	const other = side === "-" ? "+" : "-"
	return lines.flatMap((text, i) => (text[0] === other ? [] : [{ i, prefix: /^[+\- ]/.test(text) ? 1 : 0, text }]))
}

/** Sorts ranges and merges the ones that overlap or touch. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
	const merged: Array<[number, number]> = []
	for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
		const last = merged.at(-1)
		if (last && from <= last[1]) {
			last[1] = Math.max(last[1], to)
		} else {
			merged.push([from, to])
		}
	}
	return merged
}

/**
 * Finds YAML (and multi-line JSON) values that a single-line pattern cannot see. Lines are grouped into
 * mappings by key column; a list item starts a new mapping. A key whose value starts on later lines (a
 * block scalar `|-`, or an empty value) owns the lines indented deeper than its key. Those lines are
 * redacted under a credential key (`password: |`), and under the `value:` key of a mapping whose `name:`
 * is a credential (Kubernetes env), in either order. A diff header ends every mapping.
 */
function addYamlEdits(entries: LineEntry[], add: AddEdit) {
	type Mapping = { col: number; credential: boolean; values: Array<() => void> }
	const mappings: Mapping[] = []
	const credentialKeys: Array<() => void> = []
	let stack: Mapping[] = []
	let owner: { col: number; block: boolean; credential: boolean; lines: LineEntry[] } | undefined
	for (const entry of entries) {
		const { i, prefix, text } = entry
		const body = text.slice(prefix)
		const indent = body.length - body.trimStart().length
		if (DIFF_HEADER.test(text)) {
			stack = []
			owner = undefined
			continue
		}
		if (body.trim() === "") {
			continue
		}
		if (owner && indent > owner.col && (owner.block || !YAML_KEY_LINE.test(body))) {
			owner.lines.push(entry)
			continue
		}
		// A key line under a credential key without a value starts a credential mapping (`password:`, then `  value: …`).
		const credentialParent = owner?.credential === true && indent > owner.col
		owner = undefined
		const dash = YAML_ITEM_START.exec(body)
		const col = dash ? dash[0].length : indent
		if (/^[ \t]*#/.test(body)) {
			continue
		}
		while ((stack.at(-1)?.col ?? -1) > col || (dash && stack.at(-1)?.col === col)) {
			stack.pop()
		}
		let mapping = stack.at(-1)
		if (mapping?.col !== col) {
			mapping = { col, credential: credentialParent, values: [] }
			stack.push(mapping)
			mappings.push(mapping)
		}
		mapping.credential ||= YAML_CREDENTIAL_NAME.test(body)
		const key = YAML_CREDENTIAL_KEY.exec(body) ?? YAML_VALUE_KEY.exec(body)
		if (!key) {
			continue
		}
		const from = prefix + key[0].length
		const rest = text.slice(from)
		const owned: LineEntry[] = []
		const block = YAML_BLOCK_INDICATOR.test(rest)
		// The single-line rules redact the inline value of a credential key (keeping `password: string`).
		// The value of a credential pair has no credential key name, so it is redacted here.
		const isValue = YAML_VALUE_KEY.test(body)
		owner = rest.trim() === "" || block ? { col, block, credential: !isValue, lines: owned } : undefined
		const redact = () => {
			if (isValue) {
				add(i, from, text.length)
			}
			owned.forEach((line) => add(line.i, line.prefix, line.text.length))
		}
		;(isValue ? mapping.values : credentialKeys).push(redact)
	}
	// Runs after the scan, when every key has collected the lines it owns.
	credentialKeys.forEach((redact) => redact())
	mappings.filter((mapping) => mapping.credential).forEach((mapping) => mapping.values.forEach((redact) => redact()))
}

/** Index after the `>` that ends a tag (a `>` inside a quoted attribute does not), or -1 at a `<` or the end. */
function xmlTagEnd(text: string, from: number): number {
	let quote = ""
	for (let i = from; i < text.length; i++) {
		const char = text.charAt(i)
		if (char === "<") {
			return -1
		}
		if (quote) {
			quote = char === quote ? "" : quote
		} else if (char === '"' || char === "'") {
			quote = char
		} else if (char === ">") {
			return i + 1
		}
	}
	return -1
}

/**
 * Value ranges `[start, end)` of XML elements named after credential keys. An opening tag can span lines
 * and carry any attributes. The value runs to the matching closing tag: CDATA sections and comments are
 * skipped, and nested elements with the same name are counted. With `keepUnclosed`, an element that
 * never closes runs to the end of the text.
 */
function xmlCredentialValueRanges(text: string, keepUnclosed: boolean): Array<[number, number]> {
	const ranges: Array<[number, number]> = []
	const open = new Map<string, number[]>()
	XML_MARKUP.lastIndex = 0
	for (let match = XML_MARKUP.exec(text); match; match = XML_MARKUP.exec(text)) {
		if (match[0].startsWith("<!")) {
			const terminator = match[0] === "<!--" ? "-->" : "]]>"
			const end = text.indexOf(terminator, XML_MARKUP.lastIndex)
			if (end === -1) {
				break
			}
			XML_MARKUP.lastIndex = end + terminator.length
			continue
		}
		const end = xmlTagEnd(text, XML_MARKUP.lastIndex)
		if (end === -1 || text.charAt(end - 2) === "/") {
			continue
		}
		XML_MARKUP.lastIndex = end
		const name = (match[2] ?? "").toLowerCase()
		const starts = open.get(name)
		if (match[1] && starts?.length) {
			ranges.push([starts.pop() ?? end, match.index])
		} else if (!match[1] && (starts || XML_CREDENTIAL_NAME.test(name))) {
			open.set(name, starts ?? [])
			open.get(name)?.push(end)
		}
	}
	for (const start of keepUnclosed ? [...open.values()].flat() : []) {
		ranges.push([start, text.length])
	}
	return ranges
}

type RecordScan = { closer: string; credential: boolean; values: Array<[number, number]> }

/**
 * Value ranges of records that hold a credential: `{…}` objects and `<…>` tags, nested at any depth and
 * across lines. A record holds a credential when its `name` or `key` field names one (`"name": "API_TOKEN"`),
 * when it is a tag named after one (`<password value="…"/>`), or when a credential key opens it
 * (`"password": {`). Then its own `value` fields are redacted, in any order; fields of nested records are
 * not its own. Quoted strings are skipped, so a brace or `>` inside one ends no record. A closer that
 * skips open records (`{a<b}`), or the end of the text, shows that they were no records: their fields pass
 * to the enclosing record.
 */
function recordValueRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = []
	// The text outside every record. Its fields are never redacted.
	const root: RecordScan = { closer: "", credential: false, values: [] }
	const stack: RecordScan[] = []
	const open = new Map<string, number>()
	const current = () => stack.at(-1) ?? root
	const isOpen = (closer: string) => (open.get(closer) ?? 0) > 0
	const pop = (abandoned: boolean) => {
		const record = stack.pop() ?? root
		open.set(record.closer, (open.get(record.closer) ?? 0) - 1)
		const parent = current()
		const target = record.credential ? ranges : abandoned ? parent.values : []
		record.values.forEach((range) => target.push(range))
		parent.credential ||= abandoned && record.credential
	}
	for (let i = 0; i < text.length;) {
		const char = text.charAt(i)
		const top = current()
		RECORD_FIELD.lastIndex = RECORD_STRING.lastIndex = RECORD_OPENER.lastIndex = i
		const wordStart = !/\w/.test(text.charAt(i - 1))
		const field = wordStart ? RECORD_FIELD.exec(text)?.groups : undefined
		if (field) {
			const value = field.quoted ?? field.bare ?? ""
			const end = RECORD_FIELD.lastIndex - (field.quote ? 1 : 0)
			if (field.valueKey) {
				top.values.push([end - value.length, end])
			} else {
				top.credential ||= CREDENTIAL_WORD.test(value)
			}
			i = RECORD_FIELD.lastIndex
		} else if (wordStart && RECORD_STRING.test(text)) {
			i = RECORD_STRING.lastIndex
		} else if (stack.length < 64 && RECORD_OPENER.test(text)) {
			const tag = char === "<"
			const credential = tag
				? XML_CREDENTIAL_NAME.test(text.slice(i + 1, RECORD_OPENER.lastIndex))
				: CREDENTIAL_KEY_BEFORE.test(text.slice(Math.max(0, i - 128), i))
			const closer = tag ? ">" : "}"
			stack.push({ closer, credential, values: [] })
			open.set(closer, (open.get(closer) ?? 0) + 1)
			i = RECORD_OPENER.lastIndex
		} else {
			while (isOpen(char) && current().closer !== char) {
				pop(true)
			}
			if (isOpen(char)) {
				pop(false)
			}
			i++
		}
	}
	while (stack.length > 0) {
		pop(true)
	}
	return ranges
}

/** Finds the parts of one hunk side that fall inside XML credential values or credential record values. */
function addSegmentEdits(segment: LineEntry[], keepUnclosed: boolean, add: AddEdit) {
	const text = segment.map((entry) => entry.text.slice(entry.prefix)).join("\n")
	const ranges = mergeRanges(xmlCredentialValueRanges(text, keepUnclosed).concat(recordValueRanges(text)))
	let lineStart = 0
	let first = 0
	for (const { i, prefix, text: line } of segment) {
		const lineEnd = lineStart + line.length - prefix
		while ((ranges[first]?.[1] ?? Infinity) <= lineStart) {
			first++
		}
		for (let r = first, range = ranges[r]; range && range[0] < lineEnd; range = ranges[++r]) {
			add(i, prefix + Math.max(range[0], lineStart) - lineStart, prefix + Math.min(range[1], lineEnd) - lineStart)
		}
		lineStart = lineEnd + 1
	}
}

/**
 * Redacts values that a single-line pattern cannot see (YAML blocks and name/value pairs, XML credential
 * elements, credential records). A diff mixes the old and new file, so each side (context lines plus its `-` or `+` lines) is
 * scanned on its own, and a diff file or hunk header ends any value. Both sides read the original lines;
 * the edits are merged and applied once. Each redacted part keeps its diff prefix and leading whitespace.
 */
function redactStructuredValues(content: string): string {
	const lines = content.split("\n")
	const edits = new Map<number, Array<[number, number]>>()
	const add: AddEdit = (i, from, to) => {
		const intervals = edits.get(i) ?? []
		intervals.push([from, to])
		edits.set(i, intervals)
	}
	for (const side of ["-", "+"] as const) {
		const entries = sideLines(lines, side)
		addYamlEdits(entries, add)
		let codeFile = false
		let segment: LineEntry[] = []
		for (const entry of [...entries, { i: lines.length, prefix: 0, text: "@@ " }]) {
			const line = entry.text
			if (!DIFF_HEADER.test(line)) {
				segment.push(entry)
				continue
			}
			addSegmentEdits(segment, !codeFile, add)
			segment = []
			// The new path ends the header line, quoted (`"b/my file.ts"`) or not, with or without the `b/` prefix.
			codeFile = line.startsWith("diff --git ") ? CODE_FILE.test(line.replace(/"?\r?$/, "")) : codeFile
		}
	}
	for (const [i, intervals] of edits) {
		const line = lines[i] ?? ""
		let rebuilt = ""
		let cursor = 0
		for (const [from, to] of mergeRanges(intervals)) {
			const part = line.slice(from, to)
			const kept = part.slice(0, part.length - part.trimStart().length)
			rebuilt += line.slice(cursor, from) + (part.trim() === "" ? part : `${kept}[REDACTED]`)
			cursor = to
		}
		lines[i] = rebuilt + line.slice(cursor)
	}
	return lines.join("\n")
}

/**
 * Redacts secrets, private keys, credential tokens, and email addresses from content before it is
 * sent to an LLM. The content can be a Git diff: each diff side is scanned on its own.
 */
export function redactSensitiveInformation(content: string): string {
	// Runs first, while the YAML block indicator (`|` or `>`), the XML tags and the records are unchanged.
	let redacted = redactStructuredValues(content)
	for (const [pattern, replacement] of REDACTION_RULES) {
		redacted = redacted.replace(pattern, replacement)
	}
	// Runs after the URL credential rule so `user:password@host` is handled there first.
	return redactEmailAddresses(redacted)
}
