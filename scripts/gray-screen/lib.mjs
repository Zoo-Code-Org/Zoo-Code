// Shared helpers for the gray-screen tooling. Tests: node --test scripts/gray-screen/__tests__/lib.test.mjs
import fs from "node:fs"
import path from "node:path"

/** `--flag value` pairs; a flag without a value (or followed by another flag) is an error. */
export function parseFlagArgs(argv) {
	const entries = []

	argv.forEach((cur, i) => {
		if (!cur.startsWith("--")) return
		const value = argv[i + 1]
		if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${cur}`)
		entries.push([cur.slice(2), value])
	})

	return Object.fromEntries(entries)
}

export function integerFlag(name, value, min) {
	const number = Number(value)
	if (!Number.isInteger(number) || number < min) throw new Error(`--${name} must be an integer >= ${min}`)
	return number
}

/** A plain relative path that is safe to interpolate into shell commands and to resolve under a workspace. */
export function validateRelativeDir(dir) {
	const segments = dir.split("/")
	const isSafe =
		/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(dir) &&
		segments.every((part) => part !== "." && part !== ".." && !part.startsWith("-"))

	if (!isSafe) {
		throw new Error(
			`Invalid --dir "${dir}": use a relative path of letters, digits, ".", "_" and "-" without "." or ".." segments and without segments starting with "-".`,
		)
	}

	return dir
}

/** Resolves a request path to a regular file inside `root` (after symlink resolution), or undefined. */
export function resolveServedFile(root, rawPath) {
	try {
		const realRoot = fs.realpathSync(root)
		const decoded = decodeURIComponent(rawPath)
		const real = fs.realpathSync(path.resolve(realRoot, "." + (decoded === "/" ? "/index.html" : decoded)))
		const rel = path.relative(realRoot, real)
		if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return undefined
		return fs.statSync(real).isFile() ? real : undefined
	} catch {
		return undefined
	}
}

/**
 * Writes a task into `<storage>/tasks/<taskId>` all-or-nothing: the files are written into a staging directory
 * next to `tasks/`, which is renamed into place only after every write succeeded.
 * `files` maps a file name to the value to serialize. Returns the final task directory.
 */
export function writeTaskAtomically(storage, taskId, files) {
	const staging = path.join(storage, `.task-staging-${taskId}`)
	const taskDir = path.join(storage, "tasks", taskId)

	try {
		fs.mkdirSync(staging, { recursive: true })
		for (const [name, value] of Object.entries(files)) {
			fs.writeFileSync(path.join(staging, name), JSON.stringify(value))
		}
		fs.mkdirSync(path.dirname(taskDir), { recursive: true })
		fs.renameSync(staging, taskDir)
	} catch (error) {
		fs.rmSync(staging, { recursive: true, force: true })
		throw error
	}

	return taskDir
}
