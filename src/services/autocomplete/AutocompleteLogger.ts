import * as vscode from "vscode"

/**
 * Diagnostic log for the inline-completion pipeline, gated on
 * `zoo-code.autocomplete.debugLogging`.
 *
 * Completions fail silently by design — a provider that returns `undefined`
 * looks identical whether it was filtered, cancelled, empty, or errored. Without
 * this the only symptom is "no ghost text", which is why misconfiguration is so
 * hard to tell apart from a bug.
 */
export class AutocompleteLogger {
	private channel: vscode.OutputChannel | undefined

	constructor(private readonly isEnabled: () => boolean) {}

	/** Logs a pipeline event. Cheap no-op when debug logging is off. */
	log(event: string, detail?: Record<string, unknown>): void {
		if (!this.isEnabled()) {
			return
		}

		const parts = detail
			? Object.entries(detail)
					.map(([key, value]) => `${key}=${format(value)}`)
					.join(" ")
			: ""

		this.write(`[autocomplete] ${event}${parts ? ` ${parts}` : ""}`)
	}

	/** Logs a rendered prompt across multiple lines so it stays readable. */
	logPrompt(label: string, text: string): void {
		if (!this.isEnabled()) {
			return
		}

		this.write(`[autocomplete] ${label} ─────────────`)
		this.write(text)
		this.write("[autocomplete] ─────────────────────")
	}

	dispose(): void {
		this.channel?.dispose()
		this.channel = undefined
	}

	private write(line: string): void {
		// Created lazily so a user who never enables debug logging never gets a
		// stray output channel in their panel.
		this.channel ??= vscode.window.createOutputChannel("Zoo Code Autocomplete")
		this.channel.appendLine(line)
	}
}

/** Compact, single-line rendering; strings are quoted so empty values are visible. */
function format(value: unknown): string {
	if (typeof value === "string") {
		return JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}…` : value)
	}

	return String(value)
}
