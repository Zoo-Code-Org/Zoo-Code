/**
 * Structured trace points for task-persistence file writes and shutdown.
 *
 * The restart-persistence investigation in issue #2130 could not tell which
 * writer touched ui_messages.json or when, because nothing logged the
 * replacement-protocol steps. These trace lines record the write stages, the
 * marker check, and shutdown with the task ID and the process ID, so CI logs
 * and extension logs can order writer activity across a restart.
 *
 * Shared JSON recovery failures include the file path and error code even
 * when the writer or reader has no task-specific trace callback.
 *
 * The default sink is the console. Extension activation installs a sink that
 * also mirrors every line into the extension output channel; tests can
 * install their own sink to capture events. Tracing must never break
 * persistence, so sink failures are swallowed.
 */

export type PersistenceTraceStage =
	| "json-recovery-failed"
	| "json-recovered"
	| "json-cleanup-failed"
	| "ui-messages-recovery"
	| "ui-messages-write-start"
	| "ui-messages-backup-rename"
	| "ui-messages-replacement-rename"
	| "ui-messages-write-complete"
	| "ui-messages-marker-check"
	| "shutdown"

export type PersistenceTraceFields = {
	taskId?: string
	filePath?: string
	result?: string
	detail?: string
}

type PersistenceTraceSink = (line: string) => void

let traceSink: PersistenceTraceSink | undefined

/**
 * Installs the sink used for every subsequent trace event. Pass undefined to
 * restore the default console sink.
 */
export function setPersistenceTraceSink(sink: PersistenceTraceSink | undefined): void {
	traceSink = sink
}

export function tracePersistenceEvent(stage: PersistenceTraceStage, fields: PersistenceTraceFields = {}): void {
	const line = `[persistence-trace] ${JSON.stringify({
		ts: new Date().toISOString(),
		pid: process.pid,
		stage,
		...fields,
	})}`
	try {
		if (traceSink) {
			traceSink(line)
		} else {
			console.log(line)
		}
	} catch {
		// A failing sink must never break the write, read, or shutdown path.
	}
}
