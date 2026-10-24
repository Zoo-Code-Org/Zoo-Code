import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import { createHash } from "crypto"

import { readPhaseResult } from "./phaseProtocol"

const SCENARIO_ROOT_PREFIX = "roo-vscode-e2e-restart-"

export type ScenarioWorkspace = {
	root: string
	workspace: string
	userData: string
	extensions: string
	results: string
}

function childPath(root: string, name: string): string {
	const resolvedRoot = path.resolve(root)
	const resolvedChild = path.resolve(resolvedRoot, name)
	if (path.dirname(resolvedChild) !== resolvedRoot) {
		throw new Error(`Scenario path escaped its root: ${name}`)
	}
	return resolvedChild
}

export async function createScenarioWorkspace(): Promise<ScenarioWorkspace> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), SCENARIO_ROOT_PREFIX))
	const scenarioWorkspace: ScenarioWorkspace = {
		root,
		workspace: childPath(root, "workspace"),
		userData: childPath(root, "user-data"),
		extensions: childPath(root, "extensions"),
		results: childPath(root, "results"),
	}

	await Promise.all(
		[
			scenarioPath(scenarioWorkspace, "workspace"),
			scenarioPath(scenarioWorkspace, "userData"),
			scenarioPath(scenarioWorkspace, "extensions"),
			scenarioPath(scenarioWorkspace, "results"),
		].map((directory) => fs.mkdir(directory, { recursive: true })),
	)

	return scenarioWorkspace
}

function scenarioPath(scenarioWorkspace: ScenarioWorkspace, key: "workspace" | "userData" | "extensions" | "results") {
	return scenarioWorkspace[key]
}

export async function removeScenarioWorkspace(scenarioWorkspace: ScenarioWorkspace): Promise<void> {
	const root = path.resolve(scenarioWorkspace.root)
	const tempRoot = path.resolve(os.tmpdir())
	if (path.dirname(root) !== tempRoot || !path.basename(root).startsWith(SCENARIO_ROOT_PREFIX)) {
		throw new Error(`Refusing to remove an unowned scenario root: ${scenarioWorkspace.root}`)
	}

	await fs.rm(root, { recursive: true, force: true })
}

const FAILURE_ARTIFACTS_DIR = "test-failures"

type FileDiagnostic = {
	pathHash: string
	name?: string
	kind: "file" | "directory" | "symlink" | "error"
	directoryHash: string
	class: "backup" | "new-temp" | "lock" | "other"
	target?: string
	size?: number
	sha256?: string
	code?: string
}

function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}

function diagnosticCode(error: unknown): string {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
	return typeof code === "string" && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EBUSY", "EIO"].includes(code)
		? code
		: "IO_ERROR"
}

type TraceDiagnostic = { stage: string; pid: number; ts: string }

const knownFiles = ["ui_messages.json", "api_conversation_history.json", "history_item.json"]

function classifyFile(name: string): Pick<FileDiagnostic, "class" | "target"> {
	const leftover = /^\.([^/\\]+)\.(bak|new)_[^/\\]+\.tmp$/.exec(name)
	if (leftover)
		return {
			class: leftover[2] === "bak" ? "backup" : "new-temp",
			target: knownFiles.includes(leftover[1] ?? "") ? leftover[1] : undefined,
		}
	const lock = /^([^/\\]+)\.lock$/.exec(name)
	if (lock) return { class: "lock", target: knownFiles.includes(lock[1] ?? "") ? lock[1] : undefined }
	return { class: "other" }
}

function traceDiagnostics(data: Buffer): TraceDiagnostic[] {
	const traces: TraceDiagnostic[] = []
	// Unknown stages stay private until their publication is reviewed.
	const stages = new Set([
		"json-recovery-failed",
		"ui-messages-recovery",
		"ui-messages-write-start",
		"ui-messages-backup-rename",
		"ui-messages-replacement-rename",
		"ui-messages-write-complete",
		"ui-messages-marker-check",
		"shutdown",
	])
	const marker = "[persistence-trace] "
	for (const line of data.toString("utf8").split(/\r?\n/)) {
		const start = line.indexOf(marker)
		if (start < 0) continue
		try {
			const value: unknown = JSON.parse(line.slice(start + marker.length))
			if (!value || typeof value !== "object" || !("stage" in value) || !("pid" in value) || !("ts" in value))
				continue
			const { stage, pid, ts } = value
			if (
				typeof stage !== "string" ||
				!stages.has(stage) ||
				typeof pid !== "number" ||
				!Number.isSafeInteger(pid) ||
				pid <= 0
			)
				continue
			if (
				typeof ts !== "string" ||
				!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts) ||
				!Number.isFinite(Date.parse(ts))
			)
				continue
			traces.push({ stage, pid, ts })
		} catch {
			// A malformed or truncated log line must not expose its raw contents.
		}
	}
	return traces
}

async function fileDiagnostics(
	directory: string,
	relative = "",
	traces?: TraceDiagnostic[],
): Promise<FileDiagnostic[]> {
	const files: FileDiagnostic[] = []
	for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
		const child = path.join(relative, entry.name)
		const identity = { pathHash: hash(child), directoryHash: hash(relative), ...classifyFile(entry.name) }
		try {
			if (entry.isSymbolicLink()) files.push({ ...identity, kind: "symlink" })
			else if (entry.isDirectory()) {
				if (identity.class === "lock") files.push({ ...identity, kind: "directory" })
				files.push(...(await fileDiagnostics(directory, child, traces)))
			} else if (entry.isFile()) {
				const data = await fs.readFile(path.join(directory, child))
				if (traces) traces.push(...traceDiagnostics(data))
				// Arbitrary filenames can also contain private data. Publish only known names.
				const name = knownFiles.includes(entry.name) ? entry.name : undefined
				files.push({ ...identity, name, kind: "file", size: data.length, sha256: hash(data) })
			}
		} catch (error) {
			files.push({ ...identity, kind: "error", code: diagnosticCode(error) })
		}
	}
	return files
}

/** Publish metadata only. Never copy task contents, phase errors, or raw logs. */
export async function preserveScenarioWorkspace(scenarioWorkspace: ScenarioWorkspace): Promise<string> {
	const destinationRoot = path.resolve(
		__dirname,
		"../../",
		FAILURE_ARTIFACTS_DIR,
		path.basename(scenarioWorkspace.root),
	)
	try {
		await fs.rm(destinationRoot, { recursive: true, force: true })
		await fs.mkdir(destinationRoot, { recursive: true })
		const selections = [
			{ label: "phase-results", source: scenarioWorkspace.results },
			{ label: "vscode-logs", source: path.join(scenarioWorkspace.userData, "logs") },
			{
				label: "tasks",
				source: path.join(
					scenarioWorkspace.userData,
					"User",
					"globalStorage",
					"zoocodeorganization.zoo-code",
					"tasks",
				),
			},
		]
		const sources = []
		const traces: TraceDiagnostic[] = []
		for (const selection of selections) {
			try {
				sources.push({
					label: selection.label,
					status: "collected",
					files: await fileDiagnostics(
						selection.source,
						"",
						selection.label === "vscode-logs" ? traces : undefined,
					),
				})
			} catch (error) {
				const code = diagnosticCode(error)
				sources.push({ label: selection.label, status: code === "ENOENT" ? "missing" : "error", code })
			}
		}
		const phases = []
		for (const phase of ["create", "verify"] as const) {
			try {
				const result = await readPhaseResult(scenarioWorkspace.results, phase)
				phases.push({ phase, status: result.status })
			} catch (error) {
				phases.push({ phase, code: diagnosticCode(error) })
			}
		}
		await fs.writeFile(
			path.join(destinationRoot, "diagnostics.json"),
			JSON.stringify(
				{
					sources,
					phases,
					traces: [...new Map(traces.map((event) => [JSON.stringify(event), event])).values()].sort((a, b) =>
						a.ts.localeCompare(b.ts),
					),
				},
				null,
				2,
			),
		)
		return destinationRoot
	} finally {
		// Collection or output errors must not leave the temporary workspace behind.
		await removeScenarioWorkspace(scenarioWorkspace)
	}
}
