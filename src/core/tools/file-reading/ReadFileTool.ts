/** Modern single-file reading, with a separate legacy conversation adapter. */
import path from "path"
import type { ReadFileParams, ReadFileToolParams, ClineSayTool } from "@roo-code/types"
import { isLegacyReadFileParams } from "@roo-code/types"
import type { Task } from "../../task/Task"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { getReadablePath } from "../../../utils/path"
import type { ToolUse } from "../../../shared/tools"
import { ReadFileResultFormatter } from "./ReadFileResultFormatter"
import { LegacyFileReader } from "./LegacyFileReader"
import { ModernFileReader } from "./ModernFileReader"
import { validateReadFileNumbers } from "./readFileValidation"
import type { FileResult, ReadEntryOptions } from "./types"
import { BaseTool, type ToolCallbacks } from "../BaseTool"

export class ReadFileTool extends BaseTool<"read_file"> {
	readonly name = "read_file" as const

	constructor(
		private readonly resultFormatter: ReadFileResultFormatter = new ReadFileResultFormatter(),
		private readonly fileReader: ModernFileReader = new ModernFileReader(),
		private readonly legacyFileReader: LegacyFileReader = new LegacyFileReader(),
	) {
		super()
	}

	async execute(params: ReadFileToolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		if (isLegacyReadFileParams(params)) {
			if (await this.reportMissingParameter(!params.files?.length, "files", task, callbacks)) return
			callbacks.pushToolResult(await this.legacyFileReader.read(params.files, task))
			return
		}
		if (await this.reportMissingParameter(!params.path, "path", task, callbacks)) return
		const validationError = validateReadFileNumbers(params)
		if (validationError) {
			callbacks.pushToolResult(`Error: ${validationError}`)
			return
		}
		const result = await this.readEntry(params, task)
		if (result.status === "error" || result.status === "blocked") task.didToolFailInCurrentTurn = true
		callbacks.pushToolResult(this.resultFormatter.format(result, task.api.getModel().info.supportsImages ?? false))
	}

	private async reportMissingParameter(
		missing: boolean,
		parameter: "path" | "files",
		task: Task,
		callbacks: ToolCallbacks,
	): Promise<boolean> {
		if (!missing) return false
		task.consecutiveMistakeCount++
		task.recordToolError(this.name)
		callbacks.pushToolResult(`Error: ${await task.sayAndCreateMissingParamError(this.name, parameter)}`)
		return true
	}

	/** Shared modern reader. Approval belongs to each entry; callers own aggregation. */
	async readEntry(params: ReadFileParams, task: Task, options: ReadEntryOptions = {}): Promise<FileResult> {
		return this.fileReader.read(params, task, options)
	}

	getReadFileToolDescription(blockName: string, params: { path?: string }): string
	getReadFileToolDescription(blockName: string, params: ReadFileToolParams): string
	getReadFileToolDescription(blockName: string, params: unknown): string {
		if (params && typeof params === "object" && "path" in params && params.path)
			return `[${blockName} for '${String(params.path)}']`
		return `[${blockName} with missing path]`
	}

	override async handlePartial(task: Task, block: ToolUse<"read_file">): Promise<void> {
		const args = block.nativeArgs
		const filePath = args ? (isLegacyReadFileParams(args) ? (args.files[0]?.path ?? "") : (args.path ?? "")) : ""
		const fullPath = filePath ? path.resolve(task.cwd, filePath) : ""
		const message = JSON.stringify({
			tool: "readFile",
			path: filePath ? getReadablePath(task.cwd, filePath) : "",
			isOutsideWorkspace: filePath ? isPathOutsideWorkspace(fullPath) : false,
		} satisfies ClineSayTool)
		try {
			await task.ask("tool", message, block.partial)
		} catch {
			/* Streaming asks may be replaced by a newer update. */
		}
	}
}
