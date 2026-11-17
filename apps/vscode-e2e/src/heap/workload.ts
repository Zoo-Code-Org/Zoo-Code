import type { ClineMessage } from "@roo-code/types"

export type Workload = "repeated" | "unique"
export const LARGE_TASK_MARKER = "HEAP_LARGE_TASK_READY"
export const SMALL_TASK_MARKER = "HEAP_SMALL_TASK_READY"

/** A completed transcript loaded by the real task-history and webview paths. */
export function createTranscript(workload: Workload): ClineMessage[] {
	const messages: ClineMessage[] = [{ ts: 1, type: "say", say: "text", text: "Heap benchmark task" }]
	for (let index = 0; index < 300; index++) {
		const outputId = workload === "repeated" ? index % 32 : index
		const output =
			`heap-tool-output-${outputId}\n` +
			Array.from(
				{ length: 256 },
				(_, line) => `log ${outputId}: line ${line}: deterministic tool output for memory measurement\n`,
			).join("")
		messages.push(
			{
				ts: 2 + index * 2,
				type: "ask",
				ask: "command",
				text: `cat output-${index}.log`,
				isAnswered: true,
				partial: false,
			},
			{ ts: 3 + index * 2, type: "say", say: "command_output", text: output, partial: false },
		)
	}
	messages.push({ ts: 602, type: "say", say: "completion_result", text: LARGE_TASK_MARKER, partial: false })
	return messages
}
