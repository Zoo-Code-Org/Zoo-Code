import type { ZooRunResult, ZooStreamEvent } from "@roo-code/zoo-protocol"

export type Renderer = {
	event: (event: ZooStreamEvent) => void
	result: (result: ZooRunResult) => void
	outputClosed: Promise<void>
	dispose: () => void
}

export function createRenderer(format: "text" | "json" | "stream-json", quiet: boolean): Renderer {
	let closed = false
	let lastAssistantContent: string | undefined
	let closeOutput: (() => void) | undefined
	const outputClosed = new Promise<void>((resolve) => (closeOutput = resolve))
	const onError = (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") throw error
		closed = true
		closeOutput?.()
	}
	process.stdout.on("error", onError)
	const write = (value: string): void => {
		if (!closed) process.stdout.write(value)
	}
	const dispose = () => process.stdout.removeListener("error", onError)
	if (format === "json") {
		return {
			event: () => undefined,
			result: (result) => write(`${JSON.stringify(result)}\n`),
			outputClosed,
			dispose,
		}
	}
	if (format === "stream-json") {
		return { event: (event) => write(`${JSON.stringify(event)}\n`), result: () => undefined, outputClosed, dispose }
	}
	return {
		event(event) {
			if (quiet && event.type !== "task.result" && event.type !== "system.warning") return
			switch (event.type) {
				case "system.init":
					if (!quiet) write(`Zoo ${event.clientVersion} · ${event.capabilities.join(", ")}\n`)
					break
				case "system.warning":
					write(`warning: ${event.message}\n`)
					break
				case "message.upsert":
					if (event.complete && event.role !== "user") {
						write(`${event.content}\n`)
						if (event.role === "assistant") lastAssistantContent = event.content
					}
					break
				case "task.delegated":
					if (!quiet) write(`Delegated to ${event.childTaskId}\n`)
					break
				case "ask.required":
					if (!quiet) write(`Input required: ${event.subject}\n`)
					break
				case "tool.started":
					if (!quiet) write(`Tool ${event.name} started\n`)
					break
				case "tool.completed":
					if (!quiet) write(`Tool ${event.name} completed${event.output ? `: ${event.output}` : ""}\n`)
					break
				case "tool.failed":
					write(`Tool ${event.name} failed: ${event.error.message}\n`)
					break
				case "terminal.output":
					if (!quiet) write(event.delta)
					break
				case "terminal.status":
					if (!quiet && (event.state === "exited" || event.state === "killed")) {
						write(`\nCommand ${event.state} (${event.exitCode ?? "unknown"})\n`)
					}
					break
				case "mcp.started":
					if (!quiet) write(`MCP ${event.server}/${event.operation} started\n`)
					break
				case "mcp.completed":
					if (!quiet) write(`MCP ${event.server}/${event.operation} completed\n`)
					break
				case "mcp.failed":
					write(`MCP ${event.server}/${event.operation} failed: ${event.error.message}\n`)
					break
			}
		},
		result(result) {
			if (result.content && (quiet || result.content !== lastAssistantContent)) {
				write(`${result.content}\n`)
			}
			if (!result.success) write(`${result.error?.message ?? result.outcome}\n`)
		},
		outputClosed,
		dispose,
	}
}
