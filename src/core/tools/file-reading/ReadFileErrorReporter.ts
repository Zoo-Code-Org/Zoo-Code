import type { Task } from "../../task/Task"
import type { FileResult, ReadErrorContext } from "./types"

export class ReadFileErrorReporter {
	async report(relPath: string, task: Task, error: unknown, context: ReadErrorContext = {}): Promise<FileResult> {
		const message = error instanceof Error ? error.message : String(error)
		const { prefix = "Error reading file: ", action = "Error reading file" } = context
		await task.say("error", `${action} ${relPath}: ${message}`)
		return {
			path: relPath,
			status: "error",
			error: prefix + message,
			nativeContent: `File: ${relPath}\nError: ${message}`,
		}
	}
}
