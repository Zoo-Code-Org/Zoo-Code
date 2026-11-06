/** Independent bounded abstraction; see docs/architecture/file-replacement-restart-model.md. */
import assert from "node:assert/strict"

type Version = 0 | 1 | 2
type Phase = "publishing" | "idle" | "temp" | "backup" | "committed" | "crashed" | "reading" | "read" | "deleted"
interface FileState {
	canonical: Version
	backup: Version
	temp: Version
	committed: Version
}
interface State {
	files: FileState[]
	phase: Phase
	target: number
	acknowledged: boolean
	lock: "none" | "live" | "fresh-crashed" | "stale"
	readIndex: number
	recoveryFailed: boolean
	deleted: boolean
}
interface Edge {
	action: string
	state: State
}
const FILES = ["ui", "api", "history"] as const
const MAX_STATES = 10_000
const landmarks = new Set<string>()

function edges(state: State, fixed: boolean): Edge[] {
	const result: Edge[] = []
	function add(action: string, change: (next: State) => void) {
		const next = structuredClone(state)
		change(next)
		result.push({ action, state: next })
	}
	if (state.phase === "publishing") {
		// Separate file publications: UI visibility does not acknowledge history publication.
		for (const [index, file] of state.files.entries()) {
			if (!file.canonical)
				add(`publish-${FILES[index]}`, (next) => {
					next.files[index] = { canonical: 1, backup: 0, temp: 0, committed: 1 }
					if (next.files.every((entry) => entry.canonical)) next.phase = "idle"
				})
		}
	}
	if (state.phase === "idle" && !state.acknowledged) {
		add("acknowledge-all-three-files", (next) => {
			next.acknowledged = true
		})
	}
	if (state.phase === "idle" && state.acknowledged) {
		for (const index of [0, 1, 2])
			add(`stage-replacement-${FILES[index]}`, (next) => {
				next.target = index
				next.files[index].temp = 2
				next.phase = "temp"
				next.lock = "live"
			})
	}
	if (state.phase === "temp") {
		if (fixed)
			add("atomic-commit", (next) => {
				next.files[next.target].canonical = 2
				next.files[next.target].committed = 2
				next.files[next.target].temp = 0
				next.phase = "committed"
			})
		add(fixed ? "eperm-backup-rename" : "old-backup-rename", (next) => {
			const file = next.files[next.target]
			file.backup = file.canonical
			file.canonical = 0
			next.phase = "backup"
		})
	}
	if (state.phase === "backup")
		add("fallback-commit", (next) => {
			const file = next.files[next.target]
			file.canonical = file.temp
			file.committed = file.temp
			file.temp = 0
			next.phase = "committed"
		})
	// One process crash, at every publication/replacement boundary, including post-commit cleanup.
	if (["publishing", "idle", "temp", "backup", "committed"].includes(state.phase)) {
		add("process-crash", (next) => {
			next.phase = "crashed"
			next.lock = state.lock === "live" ? "fresh-crashed" : "none"
		})
	}
	if (state.lock === "fresh-crashed")
		add("lock-becomes-stale", (next) => {
			next.lock = "stale"
		})
	if (state.phase === "crashed")
		add("fresh-host-startup", (next) => {
			next.phase = "reading"
		})
	if (state.phase === "reading") {
		const file = state.files[state.readIndex]
		if (file.canonical || !fixed || (!file.backup && !file.temp)) {
			add(`read-${FILES[state.readIndex]}`, (next) => {
				next.readIndex++
				if (next.readIndex === FILES.length) next.phase = "read"
			})
		} else if (state.lock !== "fresh-crashed") {
			// Failed scan/access/stat/rename preserves every committed byte and permits retry.
			if (!state.recoveryFailed)
				add("recovery-io-failure", (next) => {
					next.recoveryFailed = true
				})
			add("locked-reader-recovery", (next) => {
				const recovering = next.files[next.readIndex]
				recovering.canonical = recovering.backup
				recovering.backup = 0
				recovering.temp = 0
				next.lock = "none"
			})
		}
	}
	if (["crashed", "read"].includes(state.phase) && state.lock !== "fresh-crashed") {
		add("explicit-delete-under-lock", (next) => {
			next.files = next.files.map(() => ({ canonical: 0, backup: 0, temp: 0, committed: 0 }))
			next.phase = "deleted"
			next.deleted = true
			next.lock = "none"
		})
	}
	if (state.phase === "deleted")
		add("read-after-delete", (next) => {
			next.phase = "read"
		})
	return result
}

function violation(state: State): string | undefined {
	if (state.deleted && state.files.some((file) => file.canonical || file.backup)) return "deleted history resurrected"
	if (state.acknowledged && !state.deleted) {
		if (state.files.some((file) => file.canonical !== file.committed && file.backup !== file.committed)) {
			return "last committed content lost"
		}
		if (state.phase === "read" && state.files.some((file) => file.canonical !== file.committed)) {
			return "acknowledged task not discoverable/recoverable on fresh startup (#2130)"
		}
	}
	return undefined
}

function explore(fixed: boolean): number {
	const initial: State = {
		files: FILES.map(() => ({ canonical: 0, backup: 0, temp: 0, committed: 0 })),
		phase: "publishing",
		target: 0,
		acknowledged: false,
		lock: "none",
		readIndex: 0,
		recoveryFailed: false,
		deleted: false,
	}
	const queue = [{ state: initial, trace: [] as string[] }]
	const seen = new Set([JSON.stringify(initial)])
	for (let index = 0; index < queue.length; index++) {
		const { state, trace } = queue[index]
		const error = violation(state)
		if (error) {
			if (!fixed && error.includes("#2130")) {
				console.log(`Old protocol #2130 counterexample: ${trace.join(" -> ")}`)
				return seen.size
			}
			throw new Error(`${error}: ${trace.join(" -> ")}\n${JSON.stringify(state)}`)
		}
		if (fixed) {
			if (state.phase === "crashed" && state.files[0].canonical && !state.files[2].canonical)
				landmarks.add("ui-visible-history-pending")
			if (state.phase === "read" && state.acknowledged && !state.deleted) landmarks.add("acknowledged-restart")
			if (state.phase === "read" && state.recoveryFailed && !state.deleted)
				landmarks.add("retry-after-recovery-failure")
			if (state.phase === "read" && state.deleted) landmarks.add("no-resurrection")
			if (state.phase === "committed" && !state.files[state.target].backup) landmarks.add("atomic-success")
			if (state.phase === "committed" && state.files[state.target].backup) landmarks.add("fallback-success")
		}
		for (const edge of edges(state, fixed)) {
			if (fixed && edge.action === "recovery-io-failure") assert.deepEqual(edge.state.files, state.files)
			const key = JSON.stringify(edge.state)
			if (seen.has(key)) continue
			seen.add(key)
			assert.ok(seen.size <= MAX_STATES, "Replacement/restart state budget exceeded")
			queue.push({ state: edge.state, trace: [...trace, edge.action] })
		}
	}
	assert.ok(fixed, "Old protocol must reproduce #2130")
	return seen.size
}

explore(false)
const checked = explore(true)
assert.equal(landmarks.size, 6, `Unreachable replacement/restart landmarks: ${[...landmarks]}`)
console.log(
	`File replacement/restart model passed: ${checked} states, 3 files, initial publication + 1 replacement, 1 crash, 6/6 landmarks`,
)
