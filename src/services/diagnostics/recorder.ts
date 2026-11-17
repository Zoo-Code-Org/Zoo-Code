import type { DiagnosticsStructuralEvent } from "./types"

export class DiagnosticsRecorder {
	private readonly events: DiagnosticsStructuralEvent[] = []
	private totalEventCount = 0

	constructor(private readonly capacity = 200) {}

	record(event: Omit<DiagnosticsStructuralEvent, "timestamp"> & { timestamp?: string }): void {
		this.totalEventCount++
		this.events.push({ ...event, timestamp: event.timestamp ?? new Date().toISOString() })
		if (this.events.length > this.capacity) {
			this.events.splice(0, this.events.length - this.capacity)
		}
	}

	snapshot(limit = 100): { events: DiagnosticsStructuralEvent[]; truncated: boolean } {
		const boundedLimit = Math.max(0, Math.min(limit, this.capacity))
		return {
			events: this.events.slice(-boundedLimit),
			truncated: this.totalEventCount > boundedLimit,
		}
	}
}
