import * as path from "path"
import * as vscode from "vscode"
import type { ProviderSettings } from "@roo-code/types"

import { ClineProvider } from "../../core/webview/ClineProvider"
import { truncateOutput } from "../../integrations/misc/extract-text"
import { singleCompletionHandler } from "../../utils/single-completion-handler"

export interface GitRepositoryChange {
	readonly uri: vscode.Uri
	readonly status: number
}

export interface GitRepositoryState {
	readonly workingTreeChanges?: ReadonlyArray<GitRepositoryChange>
	readonly untrackedChanges?: ReadonlyArray<GitRepositoryChange>
}

export interface GitRepository {
	readonly rootUri: vscode.Uri
	readonly inputBox: {
		value: string
	}
	readonly state?: GitRepositoryState
	diff(cached?: boolean): Promise<string>
}

export interface GitAPI {
	readonly repositories: readonly GitRepository[]
}

export interface GitExtension {
	readonly enabled?: boolean
	getAPI(version: 1): GitAPI
}

export interface GenerateCommitMessageOptions {
	provider: ClineProvider
	outputChannel?: vscode.OutputChannel
	context?: unknown
}

export interface CommitMessagePrompt {
	prompt: string
	truncated: boolean
}

export const COMMIT_MESSAGE_SYSTEM_PROMPT = `You are an expert developer specializing in Git commit messages.
Generate a concise, meaningful Git commit message for the provided diff following the Conventional Commits specification (v1.0.0).

Guidelines:
1. Format: <type>(<optional scope>): <description>
   [optional body]
   [optional footer(s)]
2. Common types:
   - feat: A new feature
   - fix: A bug fix
   - docs: Documentation changes
   - style: Formatting or code style changes (no logic change)
   - refactor: Refactoring code without changing behavior
   - perf: Performance improvements
   - test: Adding or updating tests
   - build: Changes affecting build systems or dependencies
   - ci: CI/CD configuration changes
   - chore: Other maintenance changes
3. Use imperative, present tense ("add" not "added", "fix" not "fixes").
4. Keep the subject line within 72 characters and do not end with a period.
5. If the changes warrant explanation, include a blank line followed by a concise body or bullet points detailing what changed and why.
6. Return ONLY the commit message. Do NOT include markdown code blocks, quotes, or any introductory or concluding text.
7. Never output secrets, passwords, or personal identifiable information in commit messages.`

export const DIFF_LINE_LIMIT = 1000
export const DIFF_CHARACTER_LIMIT = 50_000

const GENERATING_TITLE = "Generating commit message..."
const NO_PROVIDER_MESSAGE = "No valid API provider configured. Please configure an API provider in Zoo Code settings."
const ignore = (): undefined => undefined
export const NO_CHANGES_MESSAGE = "No staged or working directory changes found to generate commit message."
export const DRAFT_CHANGED_MESSAGE =
	"The commit message box changed while Zoo Code generated a message. Your text was kept. Run the command again to replace it."
export const DIFF_TRUNCATED_MESSAGE =
	"The diff was too large and Zoo Code shortened it before generation. Make sure the commit message covers all changes."

// vscode.git Status.UNTRACKED
const UNTRACKED_STATUS = 7

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
// A record without nested braces or tags (`{"name": "API_TOKEN", "value": "…"}` or
// `<add key="DbPassword" value="…" />`), its credential name or key field, and its value field.
const FLAT_RECORD = /\{[^{}]*\}|<[^<>]*>/g
const RECORD_CREDENTIAL_NAME = new RegExp(
	String.raw`\b(?:key|name)["']?[ \t]*[:=][ \t]*["'][^"'\n]{0,256}?(?:${CREDENTIAL_KEYWORDS})`,
	"i",
)
const RECORD_VALUE = new RegExp(String.raw`(\bvalue["']?[ \t]*[:=][ \t]*)(?:${QUOTED_VALUE}|[^\s"',}>/]+)`, "gi")
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
		while (start > copiedUpTo && EMAIL_LOCAL_PART_CHAR.test(content[start - 1])) {
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

/**
 * Redacts secrets, private keys, credential tokens, and email addresses from content before it is
 * sent to an LLM.
 */
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

type LineEntry = { i: number; prefix: number }
type AddEdit = (line: number, from: number, to: number) => void

/** Each line of one diff side (context lines and the side's `-` or `+` lines) with its prefix length. */
function sideLines(lines: string[], side: "-" | "+"): LineEntry[] {
	const other = side === "-" ? "+" : "-"
	return lines.flatMap((line, i) => (line[0] === other ? [] : [{ i, prefix: /^[+\- ]/.test(line) ? 1 : 0 }]))
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
function addYamlEdits(lines: string[], entries: LineEntry[], add: AddEdit) {
	type Mapping = { col: number; credential: boolean; values: Array<() => void> }
	const mappings: Mapping[] = []
	const credentialKeys: Array<() => void> = []
	let stack: Mapping[] = []
	let owner: { col: number; block: boolean; lines: LineEntry[] } | undefined
	for (const entry of entries) {
		const { i, prefix } = entry
		const body = lines[i].slice(prefix)
		const indent = body.length - body.trimStart().length
		if (DIFF_HEADER.test(lines[i])) {
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
		owner = undefined
		const dash = YAML_ITEM_START.exec(body)
		const col = dash ? dash[0].length : indent
		if (/^[ \t]*#/.test(body)) {
			continue
		}
		while (
			stack.length > 0 &&
			(stack[stack.length - 1].col > col || (dash && stack[stack.length - 1].col === col))
		) {
			stack.pop()
		}
		if (stack.at(-1)?.col !== col) {
			stack.push({ col, credential: false, values: [] })
			mappings.push(stack[stack.length - 1])
		}
		const mapping = stack[stack.length - 1]
		mapping.credential ||= YAML_CREDENTIAL_NAME.test(body)
		const key = YAML_CREDENTIAL_KEY.exec(body) ?? YAML_VALUE_KEY.exec(body)
		if (!key) {
			continue
		}
		const from = prefix + key[0].length
		const rest = lines[i].slice(from)
		const owned: LineEntry[] = []
		const block = YAML_BLOCK_INDICATOR.test(rest)
		owner = rest.trim() === "" || block ? { col, block, lines: owned } : undefined
		// The single-line rules redact the inline value of a credential key (keeping `password: string`).
		// The value of a credential pair has no credential key name, so it is redacted here.
		const isValue = YAML_VALUE_KEY.test(body)
		const redact = () => {
			if (isValue) {
				add(i, from, lines[i].length)
			}
			owned.forEach((line) => add(line.i, line.prefix, lines[line.i].length))
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
		if (text[i] === "<") {
			return -1
		}
		if (quote) {
			quote = text[i] === quote ? "" : quote
		} else if (text[i] === '"' || text[i] === "'") {
			quote = text[i]
		} else if (text[i] === ">") {
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
		if (end === -1 || text[end - 2] === "/") {
			continue
		}
		XML_MARKUP.lastIndex = end
		const name = match[2].toLowerCase()
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

/** Finds the parts of one hunk side that fall inside XML credential values. */
function addXmlEdits(lines: string[], segment: LineEntry[], keepUnclosed: boolean, add: AddEdit) {
	const bodies = segment.map(({ i, prefix }) => lines[i].slice(prefix))
	const ranges = mergeRanges(xmlCredentialValueRanges(bodies.join("\n"), keepUnclosed))
	let lineStart = 0
	let first = 0
	for (let k = 0; k < segment.length; k++) {
		const lineEnd = lineStart + bodies[k].length
		while (first < ranges.length && ranges[first][1] <= lineStart) {
			first++
		}
		for (let r = first; r < ranges.length && ranges[r][0] < lineEnd; r++) {
			const from = Math.max(ranges[r][0], lineStart) - lineStart
			add(segment[k].i, segment[k].prefix + from, segment[k].prefix + Math.min(ranges[r][1], lineEnd) - lineStart)
		}
		lineStart = lineEnd + 1
	}
}

/**
 * Redacts values that a single-line pattern cannot see (YAML blocks and name/value pairs, XML credential
 * elements). A diff mixes the old and new file, so each side (context lines plus its `-` or `+` lines) is
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
		addYamlEdits(lines, entries, add)
		let codeFile = false
		let segment: LineEntry[] = []
		for (const entry of [...entries, { i: lines.length, prefix: 0 }]) {
			const line = lines[entry.i] ?? "@@ "
			if (!DIFF_HEADER.test(line)) {
				segment.push(entry)
				continue
			}
			addXmlEdits(lines, segment, !codeFile, add)
			segment = []
			const file = /^diff --git a\/.* b\/(.*)$/.exec(line)
			codeFile = file ? CODE_FILE.test(file[1]) : codeFile
		}
	}
	for (const [i, intervals] of edits) {
		const line = lines[i]
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

export function redactSensitiveInformation(content: string): string {
	// Run first, while the YAML block indicator (`|` or `>`) and the XML tags are unchanged.
	// A credential name and its value in one record, in any field order and at any distance.
	let redacted = redactStructuredValues(content).replace(FLAT_RECORD, (record) =>
		RECORD_CREDENTIAL_NAME.test(record) ? record.replace(RECORD_VALUE, `$1$<open>[REDACTED]$<open>`) : record,
	)
	for (const [pattern, replacement] of REDACTION_RULES) {
		redacted = redacted.replace(pattern, replacement)
	}
	// Runs after the URL credential rule so `user:password@host` is handled there first.
	return redactEmailAddresses(redacted)
}

/**
 * Accesses the VS Code Git extension API.
 */
export async function getGitApi(): Promise<GitAPI | undefined> {
	const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git")
	if (!gitExtension) {
		return undefined
	}
	if (!gitExtension.isActive) {
		await gitExtension.activate()
	}
	return gitExtension.exports?.getAPI(1)
}

interface UriFields {
	scheme: string
	fsPath: string
}

/**
 * Reads `scheme` and `fsPath` from an untrusted Uri-like value once, as plain strings. No method of
 * the value is called, so a forged `toString` cannot run.
 */
function readUriFields(value: unknown): UriFields | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined
	}
	const { scheme, fsPath } = value as { scheme?: unknown; fsPath?: unknown }
	return typeof scheme === "string" && typeof fsPath === "string" ? { scheme, fsPath } : undefined
}

function findRepositoryByRoot(git: GitAPI, root: UriFields): GitRepository | undefined {
	return git.repositories.find((r) => r.rootUri.scheme === root.scheme && r.rootUri.fsPath === root.fsPath)
}

/**
 * Resolves the Git repository for an optional SCM command context.
 *
 * The command is public, so the context is untrusted. The result is always an entry of
 * `git.repositories`. The function never returns the context object and never calls its methods.
 */
export function resolveGitRepository(git: GitAPI, context?: unknown): GitRepository | undefined {
	if (!git.repositories || git.repositories.length === 0) {
		return undefined
	}

	if (context && typeof context === "object") {
		const known = git.repositories.find((r) => r === context)
		if (known) {
			return known
		}

		// A bare Uri, or a SourceControl from the scm/title menu (rootUri + inputBox).
		// When an explicit context matches no repository, return undefined instead of
		// silently picking a different repository.
		const contextUri = readUriFields(context)
		if (contextUri) {
			return findRepositoryByRoot(git, contextUri)
		}

		const sc = context as { rootUri?: unknown; inputBox?: unknown }
		const sourceControlRoot = readUriFields(sc.rootUri)
		if (sourceControlRoot) {
			return findRepositoryByRoot(git, sourceControlRoot)
		}

		if (sc.inputBox) {
			return git.repositories.find((r) => r.inputBox === sc.inputBox)
		}
	}

	if (git.repositories.length === 1) {
		return git.repositories[0]
	}

	const activeDocUri = vscode.window.activeTextEditor?.document.uri
	if (activeDocUri) {
		const matchingRepos = git.repositories.filter((r) => {
			const root = r.rootUri.fsPath
			return (
				activeDocUri.fsPath === root ||
				activeDocUri.fsPath.startsWith(root + "/") ||
				activeDocUri.fsPath.startsWith(root + "\\")
			)
		})
		if (matchingRepos.length > 0) {
			matchingRepos.sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)
			return matchingRepos[0]
		}
	}

	return git.repositories[0]
}

/**
 * Retrieves the diff from the repository. Staged changes come first. Working tree changes are used
 * only when nothing is staged, and untracked files only when both diffs are empty.
 *
 * A failed `git diff` rejects. It is not reported as "no changes", because a failed staged read
 * would otherwise make the message describe unstaged changes that the next commit does not include.
 *
 * When `signal` is aborted, no further Git read starts and the result is undefined.
 */
export async function getRepositoryDiff(repository: GitRepository, signal?: AbortSignal): Promise<string | undefined> {
	const staged = (await repository.diff(true))?.trim()
	if (staged) {
		return staged
	}
	if (signal?.aborted) {
		return undefined
	}

	const workingTree = (await repository.diff(false))?.trim()
	if (workingTree) {
		return workingTree
	}
	if (signal?.aborted) {
		return undefined
	}

	// `git diff` omits untracked files; surface them as a plain listing so the
	// LLM can still generate an "initial commit" or "add files" message.
	// With `git.untrackedChanges: "separate"` they are in `untrackedChanges`, otherwise in
	// `workingTreeChanges`. Read both and de-duplicate by path.
	// Paths are relative to the repository root so absolute local paths are not sent.
	const state = repository.state
	const untrackedPaths = new Set(
		[
			...(state?.workingTreeChanges ?? []).filter((c) => c.status === UNTRACKED_STATUS),
			...(state?.untrackedChanges ?? []),
		].map((c) => c.uri.fsPath),
	)
	if (untrackedPaths.size > 0) {
		const rootPath = repository.rootUri.fsPath
		const fileList = [...untrackedPaths].map((p) => path.relative(rootPath, p) || p).join("\n")
		return `Untracked files:\n${fileList}`
	}

	return undefined
}

/**
 * Cleans the commit message output from LLM completions.
 */
export function cleanCommitMessage(message: string): string {
	let cleaned = message.trim()
	if (cleaned.startsWith("```")) {
		cleaned = cleaned.replace(/^```[a-zA-Z]*\r?\n?/, "")
		cleaned = cleaned.replace(/\r?\n?```$/, "")
		cleaned = cleaned.trim()
	}
	if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
		cleaned = cleaned.slice(1, -1).trim()
	}
	return cleaned
}

/**
 * Builds the full prompt to generate a commit message from a git diff.
 * `truncated` is true when the diff exceeded the line or character limit and was shortened.
 */
export function buildCommitMessagePrompt(diff: string): CommitMessagePrompt {
	const sanitizedDiff = redactSensitiveInformation(diff)
	const truncatedDiff = truncateOutput(sanitizedDiff, DIFF_LINE_LIMIT, DIFF_CHARACTER_LIMIT)
	return {
		prompt: `${COMMIT_MESSAGE_SYSTEM_PROMPT}\n\nDiff:\n\`\`\`diff\n${truncatedDiff}\n\`\`\`\n\nCommit Message:`,
		truncated: truncatedDiff !== sanitizedDiff,
	}
}

// Invocation order for the stale-write check. Numbers are assigned before the first await, so they
// follow call order. The latest number is tracked per repository so that a request for one
// repository never discards the result for another.
let invocationCounter = 0
// Keyed by scheme and root path, not by the repository object: the Git API returns new wrapper objects
// for the same repository on each read of `repositories`.
const latestInvocationByRepository = new Map<string, number>()

function repositoryKey(repository: GitRepository): string {
	return `${repository.rootUri.scheme}:${repository.rootUri.fsPath}`
}

// The provider requests in flight, per repository, until each one settles. At most one provider request
// per repository runs at a time: a newer request first aborts the older ones (their results would be
// discarded anyway) and waits until they settle, because a provider that ignores the abort signal keeps
// working after the abort. The wait is capped: when an older request is still running after the cap,
// the newer request stops with a message and starts no provider request.
interface InFlightRequest {
	settled: Promise<void>
	cancel: () => void
}
const inFlightRequestsByRepository = new Map<string, Set<InFlightRequest>>()
export const PREVIOUS_REQUEST_WAIT_MS = 30_000
export const WAITING_FOR_PREVIOUS_REQUEST_MESSAGE = "Waiting for the previous request to finish..."
export const PREVIOUS_REQUEST_STILL_RUNNING_MESSAGE =
	"The previous request is still running, so Zoo Code did not start a new one. Try again when it finishes."

/**
 * Clears the per-repository request state, so that tests do not share it.
 * @internal
 */
export function resetCommitMessageRequestState(): void {
	latestInvocationByRepository.clear()
	inFlightRequestsByRepository.clear()
}

/** Resolves to true when `work` settles, or to false after `ms` milliseconds, whichever comes first. */
function settlesWithin(work: Promise<void>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), ms)
	})
	return Promise.race([work.then(() => true), timeout]).finally(() => clearTimeout(timer))
}

/** Tracks a provider request for the repository until it settles. */
function trackInFlight(key: string, request: InFlightRequest) {
	let requests = inFlightRequestsByRepository.get(key)
	if (!requests) {
		requests = new Set()
		inFlightRequestsByRepository.set(key, requests)
	}
	requests.add(request)
	void request.settled.then(() => {
		requests.delete(request)
		if (requests.size === 0 && inFlightRequestsByRepository.get(key) === requests) {
			inFlightRequestsByRepository.delete(key)
		}
	})
}

interface GenerationRun {
	repository: GitRepository
	provider: ClineProvider
	ownerKey: string
	invocationId: number
	draft: string
}

/** The steps inside the cancellable progress notification. Errors reach the caller's catch. */
async function runGeneration(
	{ repository, provider, ownerKey, invocationId, draft }: GenerationRun,
	progress: vscode.Progress<{ message?: string }>,
	token: vscode.CancellationToken,
): Promise<void> {
	// One listener aborts the provider request and ends every pending wait below, so the
	// notification closes as soon as the user cancels, even when Git or the provider
	// ignores the abort signal.
	const abortController = new AbortController()
	let resolveCancelled: () => void = () => {}
	const cancelled = new Promise<undefined>((resolve) => {
		resolveCancelled = () => resolve(undefined)
	})
	const cancel = () => {
		abortController.abort()
		resolveCancelled()
	}
	const cancellationListener = token.onCancellationRequested(cancel)
	if (token.isCancellationRequested) {
		cancel()
	}
	const isCancelled = () => token.isCancellationRequested || abortController.signal.aborted
	// A rejection caused by the user's cancel (for example, a provider that rejects synchronously on
	// abort and wins the race) ends the step quietly. Any other rejection reaches the caller's catch.
	function untilCancelled<T>(work: Promise<T>): Promise<T | undefined> {
		const guarded = work.catch((error: unknown) => (isCancelled() ? undefined : Promise.reject(error)))
		return Promise.race([guarded, cancelled])
	}

	try {
		if (isCancelled()) {
			return
		}

		const diff = await untilCancelled(getRepositoryDiff(repository, abortController.signal))
		if (isCancelled()) {
			return
		}
		if (!diff) {
			vscode.window.showInformationMessage(NO_CHANGES_MESSAGE)
			return
		}

		const state = await untilCancelled(provider.getState())
		if (isCancelled()) {
			return
		}
		const apiConfiguration = state?.apiConfiguration
		if (!apiConfiguration || !apiConfiguration.apiProvider) {
			vscode.window.showErrorMessage(NO_PROVIDER_MESSAGE)
			return
		}

		// Only the newest request for a repository calls the provider.
		if (latestInvocationByRepository.get(ownerKey) !== invocationId) {
			return
		}

		// Abort older provider requests for this repository and wait until they settle, so that
		// provider requests for one repository never overlap. The wait itself can be cancelled.
		const older = inFlightRequestsByRepository.get(ownerKey)
		if (older && older.size > 0) {
			const olderRequests = [...older]
			olderRequests.forEach((request) => request.cancel())
			progress.report({ message: WAITING_FOR_PREVIOUS_REQUEST_MESSAGE })
			const olderSettled = Promise.all(olderRequests.map((request) => request.settled)).then(ignore)
			const settled = await untilCancelled(settlesWithin(olderSettled, PREVIOUS_REQUEST_WAIT_MS))
			if (isCancelled()) {
				return
			}
			if (!settled) {
				vscode.window.showWarningMessage(PREVIOUS_REQUEST_STILL_RUNNING_MESSAGE)
				return
			}
			// A newer request for this repository came in during the wait and owns the input box.
			if (latestInvocationByRepository.get(ownerKey) !== invocationId) {
				return
			}
		}

		const { prompt, truncated } = buildCommitMessagePrompt(diff)
		const completion = singleCompletionHandler(apiConfiguration as ProviderSettings, prompt, {
			abortSignal: abortController.signal,
		})
		trackInFlight(ownerKey, { settled: completion.then(ignore, ignore), cancel })
		const rawMessage = await untilCancelled(completion)
		if (isCancelled() || rawMessage === undefined) {
			return
		}

		// A newer request for this repository owns the input box now.
		if (latestInvocationByRepository.get(ownerKey) !== invocationId) {
			return
		}

		const commitMessage = cleanCommitMessage(rawMessage)
		if (!commitMessage) {
			vscode.window.showWarningMessage("No commit message generated.")
			return
		}

		// Do not overwrite text the user typed while the request was pending.
		if (repository.inputBox.value !== draft) {
			vscode.window.showInformationMessage(DRAFT_CHANGED_MESSAGE)
			return
		}

		repository.inputBox.value = commitMessage
		if (truncated) {
			vscode.window.showWarningMessage(DIFF_TRUNCATED_MESSAGE)
		}
	} finally {
		cancellationListener.dispose()
	}
}

/**
 * Generates a commit message using the active LLM provider and populates the SCM input box.
 */
export async function generateCommitMessage(options: GenerateCommitMessageOptions): Promise<void> {
	const { provider, outputChannel, context } = options
	const invocationId = ++invocationCounter

	try {
		const git = await getGitApi()
		if (!git) {
			vscode.window.showErrorMessage("Git extension not found or not enabled.")
			return
		}

		const repository = resolveGitRepository(git, context)
		if (!repository) {
			vscode.window.showErrorMessage("No Git repository found.")
			return
		}

		const ownerKey = repositoryKey(repository)
		if (invocationId > (latestInvocationByRepository.get(ownerKey) ?? 0)) {
			latestInvocationByRepository.set(ownerKey, invocationId)
		}
		const draft = repository.inputBox.value

		const run: GenerationRun = { repository, provider, ownerKey, invocationId, draft }
		const options = { location: vscode.ProgressLocation.Notification, title: GENERATING_TITLE, cancellable: true }
		await vscode.window.withProgress(options, (progress, token) => runGeneration(run, progress, token))
	} catch (error) {
		// The cancel path is handled inside the progress callback, so every error here is a real
		// failure, including provider timeouts and errors whose text mentions "aborted".
		const errorMessage = error instanceof Error ? error.message : String(error)
		outputChannel?.appendLine(`[generateGitCommitMessage] failed: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to generate commit message: ${errorMessage}`)
	}
}
