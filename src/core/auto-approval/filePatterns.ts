import os from "os"
import path from "path"

import ignore from "ignore"

/**
 * Matching of file paths against user-configured file patterns.
 *
 * This is used to grant an access permission for a few named files instead of
 * for the whole workspace, for example `allowedWriteFiles`, which lists the
 * files Zoo may create or edit without asking.
 *
 * The syntax is gitignore-inspired, but deliberately differs from it in how a
 * path is anchored, because these patterns can name files anywhere on the
 * filesystem rather than only inside one repository:
 *
 * | Pattern               | Matches                                          |
 * | --------------------- | ------------------------------------------------ |
 * | `notes.md`            | that filename in any directory of the workspace  |
 * | `*.md`                | any such file in any directory of the workspace  |
 * | `docs/notes.md`       | that path relative to the workspace root         |
 * | `docs/scratch/**`     | everything below that workspace directory        |
 * | `./notes.md`          | that file in the workspace root only             |
 * | `../shared/notes.md`  | that path next to the workspace                  |
 * | `/tmp/notes.md`       | that absolute path (`/` is the filesystem root)  |
 * | `C:/tmp/notes.md`     | that absolute path on Windows                    |
 * | `~/notes.md`          | that path in the user's home directory           |
 * | `!docs/secret.md`     | excludes a file matched by an earlier pattern    |
 *
 * The differences from gitignore are all about reaching outside the workspace,
 * which gitignore has no need to do. Of the three spellings below, gitignore
 * accepts each without complaint and then matches nothing with it:
 * - `/notes.md` is an absolute filesystem path, whereas gitignore would read it
 *   as the workspace root. Absolute paths have to be expressible, and `/` is the
 *   spelling users expect for them.
 * - `./notes.md` anchors to the workspace root, the role gitignore gives to
 *   `/notes.md`.
 * - `../shared/notes.md` is resolved against the workspace root, so it names a
 *   path outside the workspace. For gitignore, `..` is a literal segment that no
 *   path inside the repository can match.
 *
 * `/` is the only directory separator, also on Windows, since a backslash
 * escapes the character after it.
 *
 * Matching is case-sensitive, except on Windows, so that a pattern is as
 * case-sensitive as the filesystem whose files it names.
 * Pattern `notes.md` must not hand out access to `NOTES.md`,
 * which on Linux is a different file.
 * This follows `git`, which compares case-sensitively unless `core.ignoreCase`
 * is set (`git init` sets it when it detects a case-insensitive filesystem).
 * It does *not* follow the `ignore` library, whose default is `ignorecase: true`
 * regardless of platform, so the option has to be passed explicitly.
 *
 * A pattern always names files, never directories: `docs/` is rejected, and
 * `docs` grants access to a *file* named `docs`, not to the directory's
 * contents. Use `docs/**` to name everything below a directory. See
 * "Why a match on a directory must not decide a file's verdict" below.
 *
 * # Why patterns and paths are rewritten before matching
 *
 * The `ignore` library matches a path against patterns as `git` does against
 * `.gitignore` entries, so both have to be relative to, and below, one base
 * directory. It therefore cannot handle:
 * - absolute paths (`/tmp/notes.md`, `C:/tmp/notes.md`), or
 * - paths that climb out of the base directory (`../shared/notes.md`).
 * Running `ignore`'s matching (`ignores()`) against such a path throws
 * `RangeError` ("path should be a `path.relative()`d string").
 * Passing such a *pattern* to `add()` throws nothing at all:
 * It is accepted and then quietly never matches, which would
 * turn a mistyped permission into a silent no-op.
 *
 * Both the configured patterns and the path being checked are therefore
 * rewritten into a single form the library accepts: a path relative to the
 * filesystem root (`/`), with any Windows drive as its first segment, in the
 * spelling `toPosixAbsolutePath` gives it.
 *
 * An alternative implementation would be to remember for each pattern whether
 * it's a workspace-scoped pattern or an absolute-filesystem pattern, and then
 * run `ignore` twice, with different base dirs. We do not do that because it
 * makes implementing negation patterns (`!`) harder, as `ignore` checks for
 * negations only within the given set of patterns; if we had 2 such sets (one
 * for workspace, one for absolute), then an absolute negation pattern like
 * `!/path/to/my/repo/secret.txt` would surprisingly not deny a relative pattern
 * such as `*.txt`, because those would be handled by different `ignore`
 * instances.
 *
 * # Why a match on a directory must not decide a file's verdict
 *
 * Git's `gitignore` decides a path by walking it from the top: it tests each ancestor
 * directory first and, once one is excluded, stops and reports the file as
 * excluded too, because
 * > It is not possible to re-include a file if a parent directory of that file
 * > is excluded.
 * (`man 5 gitignore`). `ignore` reproduces this, testing each ancestor as a
 * directory path (with a trailing slash) before the file path itself.
 *
 * Here a match grants a permission rather than withholding one, so that same
 * sentence reads: it is not possible to deny a file if a parent directory of
 * that file is granted. Which is exactly the objection: for a permission that
 * is the wrong default, in two ways.
 * - Any pattern that matches a *directory* would grant its whole subtree,
 *   which is not apparent from the pattern: `docs` would grant every file under
 *   every `docs/` directory, and a bare `*` the entire workspace, even though
 *   the table above documents patterns as naming files and `docs/` is rejected
 *   outright for naming a directory.
 * - A negation below such a directory would be silently ineffective: with
 *   `docs/**` followed by `!docs/private/secret.md`, the walk grants the
 *   `docs/private/` directory and never gets to the negation for the file.
 *
 * (In the below, `(star-star)` stands for the `**` wildcard,
 * which cannot be written literally here because its trailing slash
 * would close the JSDoc comment block.)

 * The ancestor walk is therefore neutralised by appending one rule that matches
 * directories only, and nothing else, using `!(star-star)/`
 * Being last, it decides every ancestor probe,
 * since those are the only paths carrying a trailing slash, and it leaves the
 * file's own verdict to the user's patterns. A pattern can therefore still name
 * a *file* called `docs`, and `docs/**` still grants everything below `docs/`,
 * because those rules match the file path directly rather than an ancestor.
 *
 * Example:
 * For workspace root `/path/to/repo`, the two patterns
 *     docs/(star-star)
 *     !docs/private/secret.md
 * are handed to `ignore` as
 *     /path/to/repo/docs/(star-star)
 *     !/path/to/repo/docs/private/secret.md
 *     !(star-star)/       <- appended
 * and `docs/private/secret.md` is checked as `path/to/repo/docs/private/secret.md`:
 * the ancestor probes (`path/`, ..., `path/to/repo/docs/private/`) all end in a
 * slash, so the appended rule has the last word and reports them as not granted;
 * the file path is then matched by rule 1 (granted) and rule 2 (denied), and as
 * the last match wins, the file is denied. Without the appended rule, the
 * ancestor `path/to/repo/docs/private/` would match rule 1 and end the walk
 * there, granting the file the negation was written to withhold.
 */
const MATCH_DIRECTORIES_ONLY_PATTERN = "!**/"

/**
 * Whether we're on Windows.
 */
const runningOnWindows = () => process.platform === "win32"

/**
 * Convert Windows path separators so patterns and paths share one syntax.
 *
 * Only on Windows: everywhere else a backslash is an ordinary character in a
 * filename (`touch 'my\file'` creates a single file, not a directory), so
 * converting it would rewrite a path into a different one, and let the pattern
 * `my/file` grant access to the unrelated file `my\file`.
 */
function pathsepsToPosix(value: string, isWindows: boolean): string {
	return isWindows ? value.replace(/\\/g, "/") : value
}

/**
 * A Windows drive at the root of a path: the `C:` in `C:/tmp/x`, or `C:` alone.
 *
 * The lookahead is what limits this to a drive *root*. Windows also reads `C:tmp`
 * as naming a drive, but relative to the current directory on it, which is not a
 * place this module can resolve.
 */
const DRIVE_PREFIX = /^([a-zA-Z]):(?=\/|$)/

/**
 * Rewrite an absolute path into the plain POSIX form the rest of this module
 * works in, where a Windows drive is an ordinary first path segment.
 *
 * - `"C:/tmp/x"` -> `"/C/tmp/x"`
 * - `"/tmp/x"` with `workspaceDrive = "/D"` -> `"/D/tmp/x"`, since Windows reads a
 *   path written without a drive as being on the current one
 * - `"/tmp/x"` off Windows -> `"/tmp/x"`, where there are no drives to place it on
 *
 * The colon has to go, working around `ignore` behaviour:
 * On Windows, `ignore` rejects any path that looks drive-rooted
 * (it tests `/^[a-z]:\//i` and throws `RangeError`,
 * "path should be a `path.relative()`d string").
 *
 * The bare letter cannot be mistaken for a directory of the same name, because it
 * only ever goes where Windows puts the drive, at the very root of the path: a
 * directory called `C` always sits in a later segment.
 *
 * Its case is left as typed, since a drive only occurs on Windows, where the
 * matcher ignores case anyway (see the case-sensitivity note at the top), so
 * `C:/x` and `c:/x` already agree.
 *
 * A drive is only read as one when reading paths as Windows does. Elsewhere `C:`
 * is an ordinary directory name (`mkdir 'C:'` succeeds on Linux), so `C:/notes.md`
 * is a *relative* path naming a file in it, and taking it for a drive would anchor
 * it to the filesystem root instead of the workspace.
 */
function toPosixAbsolutePath(absolutePath: string, workspaceDrive: string, isWindows: boolean): string {
	const drive = isWindows ? DRIVE_PREFIX.exec(absolutePath) : null

	return drive ? `/${drive[1]}${absolutePath.slice(drive[0].length)}` : `${workspaceDrive}${absolutePath}`
}

/**
 * The drive a path is on, spelled as the path segment that `toPosixAbsolutePath`
 * gives it: `"/C"` for `"C:/tmp/x"`. Empty when the path names no drive, as is
 * always the case off Windows.
 */
function driveSegmentOf(absolutePath: string, isWindows: boolean): string {
	const drive = isWindows ? DRIVE_PREFIX.exec(absolutePath) : null

	return drive ? `/${drive[1]}` : ""
}

/**
 * Whether a path names a place on the filesystem rather than one relative to the
 * workspace: it starts with `/`, or on Windows with a drive.
 */
function isAbsolutePath(value: string, isWindows: boolean): boolean {
	return value.startsWith("/") || (isWindows && DRIVE_PREFIX.test(value))
}

function escapesWorkspace(posixPath: string): boolean {
	return posixPath.split("/").includes("..")
}

/**
 * Drop the leading `/`, which is the last step for the path being checked: the
 * `ignore` library only matches paths relative to its base directory, which here
 * is the filesystem root.
 *
 * - `"/tmp/notes.md"` -> `"tmp/notes.md"`
 * - `"/C/tmp/notes.md"` -> `"C/tmp/notes.md"`
 */
function toRootRelativePath(posixAbsolutePath: string): string {
	return posixAbsolutePath.slice(1)
}

/**
 * Rewrite a user-supplied pattern so that it matches the root-relative paths
 * produced by `toMatcherPath()`.
 *
 * Patterns that name a directory rather than a file are rejected (`undefined`).
 *
 * The workspace root (`cwd`) is normally known, but is absent when no folder is
 * open in VS Code, and in contexts that build the extension state without one.
 * Without it, a workspace-relative pattern is rejected rather than matched
 * loosely: there is no workspace for it to be relative to, and a bare gitignore
 * pattern matches in *any* directory, so `passwd` would otherwise match
 * `/etc/passwd`, and a bare `*` would match every file on the machine.
 * That would be quite a footgun.
 * Only absolute patterns remain usable in that situation.
 *
 * When the root is known, a workspace-relative pattern has that root prefixed
 * onto it, which puts it in the same form as an absolute one. gitignore anchors
 * any pattern that has a separator at its beginning or middle, so prefixing turns
 * a bare filename such as `notes.md`, which is meant to match in any directory,
 * into a workspace-root-only match. Its reach is restored by inserting a `/**`
 * segment (whose trailing slash cannot be written in this comment, as it would
 * close the comment block) between the root and the filename: that wildcard stands
 * for any number of directories including none, so the result matches
 * `base/notes.md` as well as `base/a/b/notes.md`.
 *
 * In the below examples, `(star-star)` stands for the `**` wildcard,
 * which cannot be written literally here because its trailing slash
 * would close the JSDoc comment block.
 *
 * Examples (home directory `/home/me`).
 * - For workspace root `cwd = "/path/to/repo"`:
 *   - `"notes.md"` -> `"/path/to/repo/(star-star)/notes.md"`
 *   - `"*.md"` -> `"/path/to/repo/(star-star)/*.md"`
 *   - `"docs/notes.md"` -> `"/path/to/repo/docs/notes.md"`
 *   - `"docs/scratch/**"` -> `"/path/to/repo/docs/scratch/**"`
 *   - `"./notes.md"` -> `"/path/to/repo/notes.md"`
 *   - `"../shared/notes.md"` -> `"/path/to/shared/notes.md"`
 *     resolved against the workspace root, so it lands outside the workspace
 *   - `"~/notes.md"` -> `"/home/me/notes.md"`
 *   - `"C:/tmp/notes.md"` on Windows -> `"/C/tmp/notes.md"`, see `toPosixAbsolutePath()`
 *   - `"!docs/secret.md"` -> `"!/path/to/repo/docs/secret.md"`
 *   - `"mydir/"` -> `undefined` (because it names a dir)
 *   - `"~"` -> `undefined` (because it names a dir)
 * - For workspace root `cwd = undefined`:
 *   - `"notes.md"` with no workspace root -> `undefined`
 *     (as is any workspace-relative pattern, see above)
 *
 * Whitespace and backslashes are left as typed, because the `ignore` library
 * applies gitignore's own rules to them: leading whitespace is part of the
 * filename, trailing whitespace is dropped unless escaped (`"notes.md\ "`), and
 * a backslash escapes the character after it. Only patterns consisting solely of
 * whitespace are rejected, since they name no file.
 *
 * @param pattern - Raw pattern as typed by the user.
 * @param cwd - Workspace root, used to resolve workspace-relative patterns.
 * @param isWindows - Whether to read paths by Windows' rules; see `pathsepsToPosix`.
 * @param homeDir - Directory `~` expands to. Defaults to the real one; tests pass
 * a Windows-shaped path to exercise that platform's rules.
 * @returns The rewritten pattern, or `undefined` when the pattern can never
 * match a file (empty, a directory, or escaping an unknown workspace root).
 */
export function toMatcherPattern(
	pattern: string,
	cwd?: string,
	isWindows = runningOnWindows(),
	homeDir = os.homedir(),
): string | undefined {
	// Set gitignore's negation aside so the path is rewritten on its own merits,
	// then restore it, so that a negation is anchored exactly like the pattern it
	// is written to cancel.
	const negation = pattern.startsWith("!") ? "!" : ""
	// On Windows a backslash the user typed separates directories, so it becomes a
	// slash before anything else looks at the pattern. Elsewhere it is left alone,
	// as gitignore's escape character and a legal filename character.
	let normalized = pathsepsToPosix(pattern.slice(negation.length), isWindows)

	if (!normalized.trim() || normalized === "." || normalized === "~" || normalized.endsWith("/")) {
		return undefined
	}

	const workspacePosix = pathsepsToPosix(cwd ?? "", isWindows)
	// A path written without a drive is read as being on the workspace's, which is
	// the drive the tool call it came from would resolve it against.
	const workspaceDrive = driveSegmentOf(workspacePosix, isWindows)

	if (normalized.startsWith("~/")) {
		// Left in the user's own spelling, drive and all, for the absolute branch
		// just below to rewrite once.
		normalized = path.posix.join(pathsepsToPosix(homeDir, isWindows), normalized.slice(2))
	}

	if (isAbsolutePath(normalized, isWindows)) {
		return `${negation}${toPosixAbsolutePath(normalized, workspaceDrive, isWindows)}`
	}

	if (!cwd) {
		// No workspace for a relative pattern to be relative to; see the note above
		// on why this is not matched loosely instead.
		return undefined
	}

	// `resolve` also normalises, so that a `cwd` with a trailing slash or a `..`
	// segment does not reach the patterns below.
	const workspaceRoot = path.posix.resolve(toPosixAbsolutePath(workspacePosix, workspaceDrive, isWindows))

	if (escapesWorkspace(normalized)) {
		return `${negation}${path.posix.resolve(workspaceRoot, normalized)}`
	}

	// "./notes.md" names the workspace root explicitly.
	const isWorkspaceRootAnchored = normalized.startsWith("./")

	if (isWorkspaceRootAnchored) {
		normalized = normalized.slice(2)
	}

	// gitignore anchors a pattern to the base directory as soon as it has a
	// separator "at the beginning or middle (or both)" (gitignore(5)), and only a
	// pattern with no separator at all matches at any level below. Prefixing the
	// workspace root necessarily adds separators, which would silently turn a bare
	// filename into a root-only match; a double-star segment, standing for any
	// number of directories including none, restores its reach.
	const matchesInAnyDirectory = !isWorkspaceRootAnchored && !normalized.includes("/")

	return `${negation}${workspaceRoot}/${matchesInAnyDirectory ? "**/" : ""}${normalized}`
}

/**
 * Rewrite the path of the file being checked into the same root-relative form
 * that `toMatcherPattern` produces.
 *
 * @returns The rewritten path, or `undefined` when it names no file, or when it
 * is relative and there is no workspace root to resolve it against.
 */
function toMatcherPath(filePath: string, cwd: string | undefined, isWindows: boolean): string | undefined {
	// Not trimmed: whitespace can be part of a filename.
	const normalized = pathsepsToPosix(filePath, isWindows)

	if (!normalized.trim() || normalized === ".") {
		return undefined
	}

	const workspacePosix = pathsepsToPosix(cwd ?? "", isWindows)
	const workspaceDrive = driveSegmentOf(workspacePosix, isWindows)

	if (isAbsolutePath(normalized, isWindows)) {
		return toRootRelativePath(toPosixAbsolutePath(normalized, workspaceDrive, isWindows))
	}

	if (!cwd) {
		// A relative path cannot be placed on the filesystem without a root, and
		// the only patterns that survive without one are absolute, which such a
		// path could never match anyway.
		return undefined
	}

	const workspaceRoot = toPosixAbsolutePath(workspacePosix, workspaceDrive, isWindows)

	return toRootRelativePath(path.posix.resolve(workspaceRoot, normalized))
}

/**
 * Check whether a file path is covered by any of the configured patterns.
 *
 * Patterns are applied in the order given and the last one to match decides, so
 * a `!` pattern excludes files matched by the patterns before it. A pattern only
 * ever decides the file it names: matching one of its parent directories grants
 * nothing, see "Why a match on a directory must not decide a file's verdict".
 *
 * @param filePath - Path of the file, either absolute or relative to `cwd`.
 * @param cwd - Workspace root.
 * @param patterns - Raw patterns as configured by the user.
 * @param isWindows - Whether to read paths by Windows' rules: `\` separates
 * directories, a leading `C:` is a drive, and case is ignored. Defaults to the
 * platform in use; tests pass it explicitly to exercise either platform's rules.
 * @param homeDir - Directory `~` expands to. Defaults to the real one.
 */
export function isFileMatchedByPatterns({
	filePath,
	cwd,
	patterns,
	isWindows = runningOnWindows(),
	homeDir = os.homedir(),
}: {
	filePath?: string
	cwd?: string
	patterns?: string[]
	isWindows?: boolean
	homeDir?: string
}): boolean {
	if (!filePath || !Array.isArray(patterns) || !patterns.length) {
		return false
	}

	const candidate = toMatcherPath(filePath, cwd, isWindows)

	if (!candidate) {
		return false
	}

	const matcherPatterns = patterns
		.map((pattern) => toMatcherPattern(pattern, cwd, isWindows, homeDir))
		.filter((pattern): pattern is string => !!pattern)

	if (!matcherPatterns.length) {
		return false
	}

	try {
		return ignore({ ignoreCase: isWindows })
			.add([...matcherPatterns, MATCH_DIRECTORIES_ONLY_PATTERN])
			.ignores(candidate)
	} catch (error) {
		// A path the matcher rejects cannot be confirmed as matching, so treat it
		// as unmatched.
		console.error(`[auto-approval] Failed to match path ${filePath}:`, error)
		return false
	}
}
