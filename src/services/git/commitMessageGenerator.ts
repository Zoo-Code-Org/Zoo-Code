import * as path from "path"
import * as vscode from "vscode"
import type { ProviderSettings } from "@roo-code/types"

import { RooIgnoreController } from "../../core/ignore/RooIgnoreController"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { truncateOutput } from "../../integrations/misc/extract-text"
import { fileExistsAtPath } from "../../utils/fs"
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

// The first line of each file in a diff, also of a combined diff during a merge conflict.
const DIFF_HEADER = /^diff --(?:git|cc|combined) /
// A line before the first hunk that names one path of the file. A renamed or copied file has two.
// Git adds a tab after a `---` or `+++` path that contains a space.
const DIFF_PATH_LINE = /^(?:--- |\+\+\+ |rename from |rename to |copy from |copy to )([^\t\r\n]+)/
const GIT_PATH_ESCAPES: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }
export const IGNORED_FILE_NOTE = "(Content left out: the file is in .rooignore.)"
export const ROOIGNORE_UNREADABLE_MESSAGE = "Cannot read .rooignore. No diff was sent."

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
 * Reads a path as Git writes it. A path with special characters is quoted, and its special and
 * non-ASCII characters are C escapes (`"b/.env.pr\303\266d"` is `b/.env.pröd`).
 */
function unquoteGitPath(value: string): string {
	if (!value.startsWith('"') || !value.endsWith('"')) {
		return value
	}
	const quoted = value.slice(1, -1)
	const bytes: Buffer[] = []
	let copiedUpTo = 0
	for (const escape of quoted.matchAll(/\\([0-7]{3}|.)/g)) {
		const [sequence, code = ""] = escape
		bytes.push(Buffer.from(quoted.slice(copiedUpTo, escape.index), "utf8"))
		const isOctal = code.length === 3
		bytes.push(isOctal ? Buffer.from([parseInt(code, 8)]) : Buffer.from(GIT_PATH_ESCAPES[code] ?? code, "utf8"))
		copiedUpTo = escape.index + sequence.length
	}
	bytes.push(Buffer.from(quoted.slice(copiedUpTo), "utf8"))
	return Buffer.concat(bytes).toString("utf8")
}

/** True when `.rooignore` blocks a path of the diff section (paths are read before its first hunk). */
function isSectionBlocked(section: string[], isAllowed: (relativePath: string) => boolean): boolean {
	const firstHunk = section.findIndex((line) => line.startsWith("@@"))
	return section.slice(0, firstHunk === -1 ? section.length : firstHunk).some((line) => {
		const [, written] = DIFF_PATH_LINE.exec(line) ?? []
		if (written === undefined || written === "/dev/null") {
			return false
		}
		// The path can start with a prefix that is not part of it: `a/` and `b/` by default, `i/` or `w/` with
		// diff.mnemonicPrefix, any text with diff.srcPrefix and diff.dstPrefix, or none with diff.noPrefix.
		// The path is checked as written and without each number of leading folders. A file in a folder
		// can then be left out by a rule for the root (`/.env`), but a blocked file is never kept.
		const segments = unquoteGitPath(written).split("/")
		return segments.some((_, start) => !isAllowed(segments.slice(start).join("/")))
	})
}

/**
 * Leaves out the content of each file in the diff that `.rooignore` blocks, the same rule that keeps
 * these files out of the chat. The first line of the file stays, so the commit message can name it.
 * The list of untracked files has no path lines, so it is kept as it is.
 */
export function omitIgnoredFiles(diff: string, isAllowed: (relativePath: string) => boolean): string {
	const kept: string[] = []
	let section: string[] = []
	const closeSection = () => {
		const [header = ""] = section
		// One push per line: spreading a large file into push() would exceed the argument limit.
		for (const line of isSectionBlocked(section, isAllowed) ? [header, IGNORED_FILE_NOTE] : section) {
			kept.push(line)
		}
		section = []
	}
	for (const line of diff.split("\n")) {
		if (DIFF_HEADER.test(line)) {
			closeSection()
		}
		section.push(line)
	}
	closeSection()
	return kept.join("\n")
}

/**
 * The diff without the content of files that `.rooignore` in the repository root blocks. Rejects when
 * `.rooignore` exists but cannot be read, because the controller then allows every file.
 */
async function withoutIgnoredFiles(repository: GitRepository, diff: string): Promise<string> {
	const root = repository.rootUri.fsPath
	const rooIgnore = new RooIgnoreController(root)
	try {
		await rooIgnore.initialize()
		if (rooIgnore.rooIgnoreContent === undefined && (await fileExistsAtPath(path.join(root, ".rooignore")))) {
			throw new Error(ROOIGNORE_UNREADABLE_MESSAGE)
		}
		return omitIgnoredFiles(diff, (relativePath) => rooIgnore.validateAccess(relativePath))
	} finally {
		rooIgnore.dispose()
	}
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
	const truncatedDiff = truncateOutput(diff, DIFF_LINE_LIMIT, DIFF_CHARACTER_LIMIT)
	return {
		prompt: `${COMMIT_MESSAGE_SYSTEM_PROMPT}\n\nDiff:\n\`\`\`diff\n${truncatedDiff}\n\`\`\`\n\nCommit Message:`,
		truncated: truncatedDiff !== diff,
	}
}

// Invocation order for the stale-write check. Numbers are assigned before the first await, so they
// follow call order. The latest number is tracked per repository so that a request for one
// repository never discards the result for another.
let invocationCounter = 0
// The newest invocation per repository, and how many running invocations hold the entry. Keyed by scheme
// and root path, not by the repository object: the Git API returns new wrapper objects for the same
// repository on each read of `repositories`.
interface RepositoryOwner {
	latest: number
	holders: number
}
const ownersByRepository = new Map<string, RepositoryOwner>()
// Invocations that have a number but no repository yet. An entry is removed only when no invocation holds
// it and none is still resolving Git: a removed entry would let such an older invocation claim the repository.
let resolvingInvocations = 0

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
	ownersByRepository.clear()
	inFlightRequestsByRepository.clear()
	resolvingInvocations = 0
}

/**
 * The number of repositories with request state, for tests that check the cleanup.
 * @internal
 */
export function commitMessageRequestStateSize(): number {
	return ownersByRepository.size + inFlightRequestsByRepository.size
}

/** Resolves to true when `work` settles, or to false after `ms` milliseconds or on abort, whichever comes first. */
function settlesWithin(work: Promise<void>, ms: number, signal: AbortSignal): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), ms)
		signal.addEventListener("abort", () => resolve(false), { once: true })
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
	owner: RepositoryOwner
	invocationId: number
	draft: string
}

/** The steps inside the cancellable progress notification. Errors reach the caller's catch. */
async function runGeneration(
	{ repository, provider, ownerKey, owner, invocationId, draft }: GenerationRun,
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
		// The filter step never resolves to undefined, so undefined means the user cancelled.
		const visibleDiff = await untilCancelled(withoutIgnoredFiles(repository, diff))
		if (visibleDiff === undefined) {
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
		if (owner.latest !== invocationId) {
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
			const settled = await untilCancelled(
				settlesWithin(olderSettled, PREVIOUS_REQUEST_WAIT_MS, abortController.signal),
			)
			if (isCancelled()) {
				return
			}
			if (!settled) {
				vscode.window.showWarningMessage(PREVIOUS_REQUEST_STILL_RUNNING_MESSAGE)
				return
			}
			// A newer request for this repository came in during the wait and owns the input box.
			if (owner.latest !== invocationId) {
				return
			}
		}

		const { prompt, truncated } = buildCommitMessagePrompt(visibleDiff)
		const completion = singleCompletionHandler(apiConfiguration as ProviderSettings, prompt, {
			abortSignal: abortController.signal,
		})
		trackInFlight(ownerKey, { settled: completion.then(ignore, ignore), cancel })
		const rawMessage = await untilCancelled(completion)
		if (isCancelled() || rawMessage === undefined) {
			return
		}

		// A newer request for this repository owns the input box now.
		if (owner.latest !== invocationId) {
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
	resolvingInvocations++
	let owner: RepositoryOwner | undefined

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
		owner = ownersByRepository.get(ownerKey) ?? { latest: 0, holders: 0 }
		ownersByRepository.set(ownerKey, owner)
		owner.latest = Math.max(owner.latest, invocationId)
		owner.holders++
		resolvingInvocations--
		const draft = repository.inputBox.value

		const run: GenerationRun = { repository, provider, ownerKey, owner, invocationId, draft }
		const options = { location: vscode.ProgressLocation.Notification, title: GENERATING_TITLE, cancellable: true }
		await vscode.window.withProgress(options, (progress, token) => runGeneration(run, progress, token))
	} catch (error) {
		// The cancel path is handled inside the progress callback, so every error here is a real
		// failure, including provider timeouts and errors whose text mentions "aborted".
		const errorMessage = error instanceof Error ? error.message : String(error)
		outputChannel?.appendLine(`[generateGitCommitMessage] failed: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to generate commit message: ${errorMessage}`)
	} finally {
		if (owner) {
			owner.holders--
		} else {
			resolvingInvocations--
		}
		for (const [key, entry] of ownersByRepository) {
			if (resolvingInvocations === 0 && entry.holders === 0) {
				ownersByRepository.delete(key)
			}
		}
	}
}
