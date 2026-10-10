import type { FileWatcherEvent } from "../interfaces/file-watcher-event"
import { EventEmitter } from "vscode"

/** Owns pending filesystem events and their debounce timer, not in-flight batch work. */
export class FileEventAccumulator {
	private readonly events = new Map<string, FileWatcherEvent>()
	private timer?: ReturnType<typeof setTimeout>
	private readonly batchReady = new EventEmitter<Map<string, FileWatcherEvent>>()
	readonly onBatchReady = this.batchReady.event

	constructor(private readonly debounceDelayMs = 500) {}

	get hasPendingEvents(): boolean {
		return this.events.size > 0
	}

	add(event: FileWatcherEvent): void {
		this.events.set(event.uri.fsPath, event)
		if (this.timer !== undefined) clearTimeout(this.timer)
		this.timer = setTimeout(() => this.flush(), this.debounceDelayMs)
	}

	dispose(): void {
		if (this.timer !== undefined) clearTimeout(this.timer)
		this.timer = undefined
		this.events.clear()
		this.batchReady.dispose()
	}

	private flush(): void {
		this.timer = undefined
		const batch = new Map(this.events)
		this.events.clear()
		// Detach pending events before delivery; do not serialize or await batch execution.
		this.batchReady.fire(batch)
	}
}
