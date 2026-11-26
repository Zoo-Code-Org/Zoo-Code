import { execFile } from "node:child_process"
import { join } from "node:path"

export interface ProcessTreeEntry {
	pid: number
	parentPid: number
}

/** Validate the PID-only snapshot; never retain executable paths or command lines. */
export function parseProcessSnapshot(output: string, platform: NodeJS.Platform): ProcessTreeEntry[] {
	let candidates: unknown[]
	if (platform === "win32") {
		const value: unknown = JSON.parse(output.trim().replace(/^\uFEFF/, "") || "[]")
		candidates = Array.isArray(value) ? value : [value]
	} else {
		candidates = output
			.trim()
			.split(/\r?\n/)
			.map((line) => {
				const [parent, child] = line.trim().split(/\s+/)
				return { ProcessId: Number(child), ParentProcessId: Number(parent) }
			})
	}
	return candidates.flatMap((value): ProcessTreeEntry[] => {
		if (typeof value !== "object" || value === null) return []
		const pid = "ProcessId" in value ? value.ProcessId : undefined
		const parentPid = "ParentProcessId" in value ? value.ParentProcessId : undefined
		return typeof pid === "number" &&
			Number.isSafeInteger(pid) &&
			pid > 0 &&
			typeof parentPid === "number" &&
			Number.isSafeInteger(parentPid) &&
			parentPid >= 0
			? [{ pid, parentPid }]
			: []
	})
}

/** A snapshot is not necessarily sorted by ancestry; also tolerate cycles and duplicate rows. */
export function descendantsOf(rootPid: number, snapshot: ProcessTreeEntry[]): ProcessTreeEntry[] {
	const children = new Map<number, ProcessTreeEntry[]>()
	for (const entry of snapshot) {
		const siblings = children.get(entry.parentPid) ?? []
		siblings.push(entry)
		children.set(entry.parentPid, siblings)
	}
	const seen = new Set([rootPid])
	const result: ProcessTreeEntry[] = []
	const queue = [rootPid]
	for (let index = 0; index < queue.length; index++) {
		for (const child of children.get(queue[index]) ?? []) {
			if (seen.has(child.pid)) continue
			seen.add(child.pid)
			result.push(child)
			queue.push(child.pid)
		}
	}
	return result
}

/** WMIC is absent on affected Windows systems. Handle spawn errors and bound every lookup. */
export async function getChildProcesses(rootPid: number, platform: NodeJS.Platform = process.platform) {
	if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error("Invalid process ID")
	const windows = platform === "win32"
	const executable = windows
		? join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		: "ps"
	const args = windows
		? [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
			]
		: ["-A", "-o", "ppid=,pid="]
	const output = await new Promise<string>((resolve, reject) => {
		execFile(
			executable,
			args,
			{ encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout) => {
				if (error) reject(error)
				else resolve(stdout)
			},
		)
	})
	return descendantsOf(rootPid, parseProcessSnapshot(output, platform))
}
