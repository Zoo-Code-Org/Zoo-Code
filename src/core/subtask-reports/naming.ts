/**
 * Report filename construction for the sub-subtasks feature (design D6).
 *
 * Invariant: the host owns report persistence; children only return markdown
 * through attempt_completion. Filenames therefore derive from host-side facts
 * (the parent's task id, the child's task id) plus a model-supplied label that
 * is treated as untrusted input and sanitized before it touches the filesystem.
 */
import * as fs from "fs/promises"
import * as path from "path"

/** Upper bound for the sanitized label portion of a report filename. */
const MAX_LABEL_LENGTH = 60

/** Candidate names tried before giving up on a colliding report filename. */
const MAX_COLLISION_ATTEMPTS = 100

const WINDOWS_RESERVED_NAMES = new Set([
	"CON",
	"PRN",
	"AUX",
	"NUL",
	"COM1",
	"COM2",
	"COM3",
	"COM4",
	"COM5",
	"COM6",
	"COM7",
	"COM8",
	"COM9",
	"LPT1",
	"LPT2",
	"LPT3",
	"LPT4",
	"LPT5",
	"LPT6",
	"LPT7",
	"LPT8",
	"LPT9",
])

/**
 * Reduces an arbitrary model-supplied label to a filesystem-safe stem:
 * path separators and control characters become dashes, Windows-reserved
 * device names are prefixed, and the result is truncated. Never throws;
 * a label that sanitizes to nothing falls back to "subtask".
 */
export function sanitizeReportLabel(label: string): string {
	// Control characters first: they are invalid in every filesystem and
	// can smuggle traversal bytes past naive separator checks. A char-code
	// loop keeps the matcher free of control-character regexes.
	let safe = ""
	for (const char of label) {
		safe += char.charCodeAt(0) < 32 ? "-" : char
	}
	safe = safe
		// Path separators and the characters Windows forbids in filenames.
		.replace(/[\\/:*?"<>|]/g, "-")
		.trim()
	// Trailing dots and spaces are invalid on Windows and survive trim().
	safe = safe.replace(/[. ]+$/, "")
	if (safe === "") {
		safe = "subtask"
	}
	// Windows reserves device names with or without a trailing dot or space
	// (CON, con.txt, "CON " are all reserved), so test the first dot segment.
	const firstSegment = safe.split(".")[0].trimEnd().toUpperCase()
	if (WINDOWS_RESERVED_NAMES.has(firstSegment)) {
		safe = `_${safe}`
	}
	if (safe.length > MAX_LABEL_LENGTH) {
		safe = safe.slice(0, MAX_LABEL_LENGTH)
	}
	return safe
}

/**
 * Computes `<reportsDir>/<safe-label>-<childTaskId>.md`, appending a numeric
 * suffix when the name is already taken. The child task id is globally unique,
 * so two siblings can never target the same path even with identical labels;
 * the suffix only fires on a same-child rewrite or a hostile label that
 * sanitized to a colliding stem.
 *
 * Throws when the resolved path would escape `reportsDir` (path traversal) or
 * when every candidate name up to `MAX_COLLISION_ATTEMPTS` is already taken.
 */
export async function resolveReportPath(reportsDir: string, label: string, childTaskId: string): Promise<string> {
	const safeLabel = sanitizeReportLabel(label)
	const stem = `${safeLabel}-${childTaskId}`
	const root = path.resolve(reportsDir)

	for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
		const candidate = path.join(root, `${attempt === 0 ? stem : `${stem}-${attempt + 1}`}.md`)
		const resolved = path.resolve(candidate)
		// Containment is lexical: path.resolve does not resolve symlinks, so a
		// symlink planted in an ancestor of reportsDir could still redirect the
		// write. Planting one requires write access to the workspace, which
		// already grants full control of the reports directory, so the symlink
		// adds no capability. That trust assumption is why no realpath
		// round-trip is done here.
		if (resolved !== root && !resolved.startsWith(root + path.sep)) {
			throw new Error(`subtask report path escapes the reports directory: ${resolved}`)
		}
		try {
			await fs.access(resolved)
		} catch {
			return resolved
		}
	}
	throw new Error(`subtask report filename collision limit reached after ${MAX_COLLISION_ATTEMPTS} attempts: ${stem}`)
}
