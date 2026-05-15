import { type ChildProcess, spawnSync } from "node:child_process"

/** Stop a child process, including descendants on Windows when possible. */
export function stopProcess(proc: ChildProcess) {
	if (proc.exitCode !== null || proc.signalCode !== null) return
	if (process.platform === "win32" && proc.pid) {
		const out = spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true })
		if (!out.error && out.status === 0) return
	}
	proc.kill()
}

/** Bind an AbortSignal to a spawned process. */
export function bindAbort(proc: ChildProcess, signal?: AbortSignal, onAbort?: () => void) {
	if (!signal) return () => {}
	const abort = () => {
		clear()
		stopProcess(proc)
		onAbort?.()
	}
	const clear = () => {
		signal.removeEventListener("abort", abort)
		proc.off("exit", clear)
		proc.off("error", clear)
	}
	signal.addEventListener("abort", abort, { once: true })
	proc.on("exit", clear)
	proc.on("error", clear)
	if (signal.aborted) abort()
	return clear
}
