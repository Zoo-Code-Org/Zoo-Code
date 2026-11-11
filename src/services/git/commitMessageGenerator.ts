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

export const NO_CHANGES_MESSAGE = "No staged or working directory changes found to generate commit message."
export const DRAFT_CHANGED_MESSAGE =
	"The commit message box changed while Zoo Code generated a message. Your text was kept. Run the command again to replace it."
export const DIFF_TRUNCATED_MESSAGE =
	"The diff was too large and Zoo Code shortened it before generation. Make sure the commit message covers all changes."

// vscode.git Status.UNTRACKED
const UNTRACKED_STATUS = 7

const CREDENTIAL_KEYWORDS = [
	"api[_-]?key",
	"access[_-]?key(?:[_-]?id)?",
	"token",
	"auth",
	"client[_-]?secret",
	"private[_-]?key",
	"secret(?:[_-]?(?:access[_-]?)?key)?",
	"passw(?:or)?d",
	"passphrase",
	"pwd",
	"credentials?",
].join("|")

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

/**
 * Each entry replaces one class of sensitive value. Patterns with a `prefix` capture group keep the
 * prefix (key name, header scheme, quotes) and replace only the value, so the model still sees which
 * setting changed. The order matters: header schemes run before the generic key/value pattern, and
 * URL credentials run before the email pattern. A named group that did not take part in the match is
 * replaced with an empty string.
 */
const REDACTION_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
	// PEM private key blocks
	{
		pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		replacement: "[REDACTED_SECRET]",
	},
	// Authorization header values, with or without a scheme ("Authorization: Basic dXNlcjpwYXNz")
	{
		pattern: new RegExp(
			String.raw`(?<prefix>\bauthorization${ASSIGNMENT})(?:(?<open>["'\x60])(?<scheme>${AUTH_SCHEME})?(?:\\.|(?!\k<open>)[^\\\n])+\k<open>|(?<bareScheme>${AUTH_SCHEME})?${UNQUOTED_VALUE})`,
			"gi",
		),
		replacement: "$<prefix>$<open>$<scheme>$<bareScheme>[REDACTED]$<open>",
	},
	// Bearer tokens outside an Authorization header, in any case. Any word of 8 or more token characters
	// after "Bearer" is redacted: no shape test can tell an alphabetic token from a word, and a redacted
	// word in prose ("Bearer [REDACTED]") costs little.
	{
		pattern: /(?<prefix>\bbearer[ \t]+)[A-Za-z0-9_\-.~+/]{8,}=*/gi,
		replacement: "$<prefix>[REDACTED]",
	},
	// Cookie headers carry session tokens and can hold spaces ("Cookie: a=1; b=2"), so the whole
	// header value is redacted up to the end of the line.
	{
		pattern: new RegExp(
			String.raw`(?<prefix>\b(?:set-)?cookie${ASSIGNMENT})(?:${QUOTED_VALUE}|(?!${PRIMITIVE_TYPE_VALUE})[^\s][^\n]*)`,
			"gi",
		),
		replacement: "$<prefix>$<open>[REDACTED]$<open>",
	},
	// XML elements named after a credential key: <password>secret</password>, <apiKey>…</apiKey>
	{
		pattern: new RegExp(
			String.raw`<(?<tag>[\w.:-]{0,64}?(?:${CREDENTIAL_KEYWORDS})[\w.:-]{0,64})>[^<\n]+</\k<tag>>`,
			"gi",
		),
		replacement: "<$<tag>>[REDACTED]</$<tag>>",
	},
	// key = value, key: value, "key": "value" (env files, YAML, JSON, code). The key has no leading
	// boundary, so prefixed and camelCase names match too (NPM_TOKEN, npmToken, DB_PASSWORD).
	{
		pattern: new RegExp(
			String.raw`(?<prefix>(?:${CREDENTIAL_KEYWORDS})${ASSIGNMENT})(?:${QUOTED_VALUE}|(?!${PRIMITIVE_TYPE_VALUE})${UNQUOTED_VALUE})`,
			"gi",
		),
		replacement: "$<prefix>$<open>[REDACTED]$<open>",
	},
	// Well-known token formats that can appear without a key name
	{
		pattern:
			/\b(?:sk-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{36,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{30,}|ya29\.[A-Za-z0-9_-]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
		replacement: "[REDACTED_SECRET]",
	},
	// Webhook URLs carry their secret in the path. Scheme and host are case-insensitive (RFC 3986).
	{
		pattern:
			/(?<prefix>https:\/\/(?:hooks\.slack\.com\/services|(?:discord|discordapp)\.com\/api\/webhooks)\/)[^\s"'\x60)]+/gi,
		replacement: "$<prefix>[REDACTED]",
	},
	// Credentials embedded in URLs: scheme://user:password@host
	{
		// The user may be empty (`redis://:password@host`), and the password may contain `@`: the value
		// runs to the last `@` before the host.
		pattern: /(?<prefix>:\/\/[^\s:@/]*:)[^\s/]+(?=@)/g,
		replacement: "$<prefix>[REDACTED]",
	},
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
// A YAML block value under a credential key (`password: |` or `secret: >-`). Groups: diff prefix, indent.
const YAML_BLOCK_KEY = new RegExp(
	String.raw`^([+\- ]?)([ \t]*)[^\n]*?(?:${CREDENTIAL_KEYWORDS})["']?[ \t]*:[ \t]*[|>][-+0-9]*[ \t\r]*$`,
	"i",
)

/**
 * Redacts the lines of a YAML block value under a credential key. The block is every following line
 * that is indented deeper than the key, ignoring the one-character diff prefix (`+`, `-`, or space).
 */
function redactYamlBlockValues(content: string): string {
	const lines = content.split("\n")
	for (let i = 0; i < lines.length; i++) {
		const match = YAML_BLOCK_KEY.exec(lines[i])
		if (!match) {
			continue
		}
		const keyIndent = match[2].length
		let j = i + 1
		for (; j < lines.length; j++) {
			const body = lines[j].replace(/^[+\- ]/, "")
			if (body.trim() === "") {
				continue
			}
			const indent = body.length - body.trimStart().length
			if (indent <= keyIndent) {
				break
			}
			lines[j] = `${lines[j].slice(0, lines[j].length - body.length + indent)}[REDACTED]`
		}
		i = j - 1
	}
	return lines.join("\n")
}

export function redactSensitiveInformation(content: string): string {
	// Runs first, while the block indicator (`|` or `>`) is still on the key line.
	let redacted = redactYamlBlockValues(content)
	for (const { pattern, replacement } of REDACTION_RULES) {
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

// A provider request that the user cancelled but that is still running, per repository. A provider that
// ignores the abort signal keeps working after the cancel, so the next request for the repository waits
// until this one settles. Then a cancel followed by a retry never runs two provider requests at once.
// The wait is capped: when the cancelled request is still running after the cap, the retry stops with a
// message and starts no request.
const abandonedCompletionByRepository = new Map<string, Promise<void>>()
export const ABANDONED_REQUEST_WAIT_MS = 30_000
export const WAITING_FOR_CANCELLED_REQUEST_MESSAGE = "Waiting for the cancelled request to finish..."
export const CANCELLED_REQUEST_STILL_RUNNING_MESSAGE =
	"The cancelled request is still running, so Zoo Code did not start a new one. Try again when it finishes."

/**
 * Clears the per-repository request state, so that tests do not share it.
 * @internal
 */
export function resetCommitMessageRequestState(): void {
	latestInvocationByRepository.clear()
	abandonedCompletionByRepository.clear()
}

/** Resolves to true when `work` settles, or to false after `ms` milliseconds, whichever comes first. */
function settlesWithin(work: Promise<void>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), ms)
	})
	return Promise.race([work.then(() => true), timeout]).finally(() => clearTimeout(timer))
}

function holdUntilSettled(key: string, settled: Promise<void>) {
	abandonedCompletionByRepository.set(key, settled)
	void settled.then(() => {
		if (abandonedCompletionByRepository.get(key) === settled) {
			abandonedCompletionByRepository.delete(key)
		}
	})
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

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Generating commit message...",
				cancellable: true,
			},
			async (progress, token) => {
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
				const untilCancelled = <T>(work: Promise<T>): Promise<T | undefined> => {
					// A rejection caused by the user's cancel (for example, a provider that rejects
					// synchronously on abort and wins the race) ends the step quietly. Any other
					// rejection reaches the outer catch and is reported.
					const guarded = work.catch((error: unknown) => {
						if (isCancelled()) {
							return undefined
						}
						throw error
					})
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
						vscode.window.showErrorMessage(
							"No valid API provider configured. Please configure an API provider in Zoo Code settings.",
						)
						return
					}

					// Wait for a cancelled request that is still running, so that provider requests for this
					// repository do not overlap. The wait itself can be cancelled.
					const abandoned = abandonedCompletionByRepository.get(ownerKey)
					if (abandoned) {
						progress.report({ message: WAITING_FOR_CANCELLED_REQUEST_MESSAGE })
						const settled = await untilCancelled(settlesWithin(abandoned, ABANDONED_REQUEST_WAIT_MS))
						if (isCancelled()) {
							return
						}
						if (!settled) {
							vscode.window.showWarningMessage(CANCELLED_REQUEST_STILL_RUNNING_MESSAGE)
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
					const rawMessage = await untilCancelled(completion)
					if (isCancelled()) {
						holdUntilSettled(
							ownerKey,
							completion.then(
								() => undefined,
								() => undefined,
							),
						)
						return
					}
					if (rawMessage === undefined) {
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
			},
		)
	} catch (error) {
		// The cancel path is handled inside the progress callback, so every error here is a real
		// failure, including provider timeouts and errors whose text mentions "aborted".
		const errorMessage = error instanceof Error ? error.message : String(error)
		outputChannel?.appendLine(`[generateGitCommitMessage] failed: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to generate commit message: ${errorMessage}`)
	}
}
