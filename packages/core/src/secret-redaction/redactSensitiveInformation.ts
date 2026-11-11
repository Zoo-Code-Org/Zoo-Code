/**
 * Removes secrets from text, usually a Git diff, before it is sent to an LLM.
 *
 * The rules are blunt on purpose. No scan can find a secret value in every file format, so the rules
 * do not try to find the value. They hide every line that can hold one:
 *
 * 1. Sensitive files (`.env`, `*.pem`, `id_rsa`, `secrets.yaml`, ...): no content line is sent.
 * 2. Other files that are not code (YAML, JSON, XML, INI, Markdown, unknown types): when one content
 *    line contains a credential word, no content line of that file is sent. A value can be on a
 *    different line than its key (`- value: x` / `  name: API_TOKEN`), so the whole file is hidden.
 * 3. Code files, and text before the first `diff --git` line: a content line that contains a
 *    credential word hides its block. The block is the lines before and after it that are indented at
 *    least as deep, up to the first line on each side that is indented less (`value: x,` then
 *    `name: "API_TOKEN",` in an object literal). For a line at column 0, the block is only the deeper
 *    lines after it (a value that a formatter moved to the next line).
 * 4. Everywhere: private key blocks, well-known token formats, webhook secret paths, URL passwords,
 *    and email addresses.
 *
 * A hidden line keeps its diff prefix and indentation. The `diff --git`, `---`, `+++`, and `@@` lines
 * stay, so the model still sees which files and hunks changed. The function context after `@@` is
 * removed when it contains a credential word.
 *
 * Not covered: a secret in a code file outside the block of every credential line (`const x = "hunter2"`,
 * or a multi-line string whose lines start at column 0). No rule can tell such a value from any other string.
 */

// A credential word, case-insensitive and also inside longer names (NPM_TOKEN, dbPassword, x-api-key).
// `auth` matches `authorization` and `OAuth`, but not `author`.
const CREDENTIAL_WORD =
	/passw|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth(?!or(?!i[sz]))|credential|cookie|bearer|-----BEGIN/i
// Files that hold secrets by convention. The path is read from the end of the `diff --git` line.
const SENSITIVE_FILE =
	/(?:^|[/\\ ])(?:\.env(?:\.[^/\\ ]*)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)|(?:secrets?|credentials?)(?:\.[^/\\ ]*)?|[^/\\ ]*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|tfvars|tfstate))$/i
const CODE_FILE =
	/\.(?:[cm]?[jt]sx?|java|kts?|cs|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|swift|scala|dart|fs|vb|py|rb|go|php|lua|pl|sh|bash|zsh|ps1)$/i
// A diff content line: its prefix (`+`, `-`, or a space), its indentation, and the rest
const CONTENT_LINE = /^([+\- ]?)([ \t]*)([^\n]*)$/
const HUNK_HEADER = /^(@@ [^@\n]* @@)([^\n]*)$/

// Private key blocks. A block without an END line runs to the end of the text.
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
// Well-known token formats, also on lines without a credential word
const BARE_TOKEN =
	/\b(?:sk-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{36,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{30,}|ya29\.[A-Za-z0-9_-]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g
// Webhook URLs carry their secret in the path. Scheme and host are case-insensitive (RFC 3986).
const WEBHOOK_URL =
	/(?<prefix>https:\/\/(?:hooks\.slack\.com\/services|(?:discord|discordapp)\.com\/api\/webhooks)\/)[^\s"'\x60)]+/gi
// Credentials embedded in URLs: scheme://user:password@host. The user may be empty
// (`redis://:password@host`), and the password may contain `@`: the value runs to the last `@` before the host.
const URL_CREDENTIALS = /(?<prefix>:\/\/[^\s:@/]*:)[^\s/]+(?=@)/g

const EMAIL_LOCAL_PART_CHAR = /[A-Za-z0-9._%+-]/
const EMAIL_DOMAIN_CHAR = /[A-Za-z0-9.-]/
const EMAIL_TOP_LEVEL_LABEL = /^[A-Za-z]{2,}$/

/** Length of the email domain that starts at `from`, or 0. It has two or more labels, the last of letters only. */
function emailDomainLength(content: string, from: number): number {
	let end = from
	while (end < content.length && EMAIL_DOMAIN_CHAR.test(content.charAt(end))) {
		end++
	}
	while (end > from && content.charAt(end - 1) === ".") {
		end--
	}
	const labels = content.slice(from, end).split(".")
	const valid = labels.length > 1 && !labels.includes("") && EMAIL_TOP_LEVEL_LABEL.test(labels.at(-1) ?? "")
	return valid ? end - from : 0
}

/**
 * Replaces email addresses with [REDACTED_EMAIL] in linear time. The scan starts at each `@`, reads
 * the local part backwards up to the end of the previous replacement, and reads the domain forwards
 * without a regex, so no character is read more than a constant number of times.
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
		const domainLength = start < at ? emailDomainLength(content, at + 1) : 0
		if (domainLength > 0) {
			result += content.slice(copiedUpTo, start) + "[REDACTED_EMAIL]"
			copiedUpTo = at + 1 + domainLength
			at = content.indexOf("@", copiedUpTo)
		} else {
			at = content.indexOf("@", at + 1)
		}
	}
	return result + content.slice(copiedUpTo)
}

/** Hides the content lines of one file of the diff (rules 1 to 3). `header` is its `diff --git` line. */
function hideFileLines(lines: string[], header: string | undefined): string[] {
	const path = header?.replace(/"?\r?$/, "")
	// Text before the first `diff --git` line (for example a list of untracked files) is all content.
	let inHunk = path === undefined
	const isContent = lines.map((line) => {
		inHunk = (inHunk && !line.startsWith("diff --git ")) || line.startsWith("@@")
		return inHunk && !line.startsWith("@@")
	})
	const hideAll =
		(path !== undefined && SENSITIVE_FILE.test(path)) ||
		(path !== undefined &&
			!CODE_FILE.test(path) &&
			lines.some((line, i) => isContent[i] && CREDENTIAL_WORD.test(line)))
	const hidden = lines.map(() => hideAll)
	// Marks the blocks of credential lines (rule 3) in one direction. A hunk header ends every block.
	const markBlocks = (order: number[], backward: boolean) => {
		let blockIndent = -1
		for (const i of order) {
			const [, , indent = "", rest = ""] = CONTENT_LINE.exec(lines[i] ?? "") ?? []
			if (!isContent[i]) {
				blockIndent = -1
			} else if (rest.trim() !== "") {
				blockIndent = indent.length < Math.max(blockIndent, 1) ? -1 : blockIndent
				if (CREDENTIAL_WORD.test(rest) && (!backward || indent.length > 0)) {
					blockIndent = indent.length
				}
				hidden[i] ||= blockIndent >= 0
			}
		}
	}
	const order = lines.map((_, i) => i)
	markBlocks(order, false)
	markBlocks(order.reverse(), true)
	return lines.map((line, i) => {
		const hunk = HUNK_HEADER.exec(line)
		if (hunk) {
			return CREDENTIAL_WORD.test(hunk[2] ?? "") ? (hunk[1] ?? line) : line
		}
		const [, prefix = "", indent = "", rest = ""] = CONTENT_LINE.exec(line) ?? []
		return isContent[i] && hidden[i] && rest.trim() !== "" ? `${prefix}${indent}[REDACTED]` : line
	})
}

/**
 * Redacts secrets from content before it is sent to an LLM, with the rules described at the top of
 * this file. The content can be a Git diff or plain text. Runs in linear time.
 */
export function redactSensitiveInformation(content: string): string {
	const lines = content.replace(PEM_PRIVATE_KEY, "[REDACTED_SECRET]").split("\n")
	const hidden: string[] = []
	let start = 0
	for (let i = 1; i <= lines.length; i++) {
		if (i === lines.length || lines[i]?.startsWith("diff --git ")) {
			const header = lines[start]?.startsWith("diff --git ") ? lines[start] : undefined
			hideFileLines(lines.slice(start, i), header).forEach((line) => hidden.push(line))
			start = i
		}
	}
	const redacted = hidden
		.join("\n")
		.replace(BARE_TOKEN, "[REDACTED_SECRET]")
		.replace(WEBHOOK_URL, "$<prefix>[REDACTED]")
		.replace(URL_CREDENTIALS, "$<prefix>[REDACTED]")
	// Runs after the URL credential rule so `user:password@host` is handled there first.
	return redactEmailAddresses(redacted)
}
