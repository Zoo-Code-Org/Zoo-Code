import {
	ANTHROPIC_DEFAULT_MAX_TOKENS,
	readFilesParamsSchema,
	type ReadFilesParams,
	type ReadFileParams,
	READ_FILES_TOOL_NAME,
	MAX_READ_FILES,
} from "@roo-code/types"
import type { Task } from "../../task/Task"
import { getModelMaxOutputTokens } from "../../../shared/api"
import { BaseTool, type ToolCallbacks } from "../BaseTool"
import { ReadFileTool } from "./ReadFileTool"
import { DEFAULT_LINE_LIMIT } from "./readFileConstants"
import { getReadFileBatchBudget } from "./readFileBatchBudget"
import { ReadFileBatchOutput } from "./readFileBatchOutput"
import type { BatchFileResult } from "./readFileBatchEntry"

const MIN_FILE_CONTENT_BYTES = 256

export class ReadFilesTool extends BaseTool<typeof READ_FILES_TOOL_NAME> {
	readonly name = READ_FILES_TOOL_NAME

	constructor(private readonly fileReader: Pick<ReadFileTool, "readEntry"> = new ReadFileTool()) {
		super()
	}

	async execute(params: ReadFilesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		// Validate again at the execution boundary (including resumed conversations).
		const parsed = readFilesParamsSchema.safeParse(params)
		if (!parsed.success) {
			task.recordToolError(this.name)
			callbacks.pushToolResult(
				`Error: ${READ_FILES_TOOL_NAME} requires 1-${MAX_READ_FILES} valid modern entries (path, slice/indentation options); legacy ranges are not supported.`,
			)
			return
		}
		const { entries } = parsed.data
		const output = this.createBatchOutput(entries, task)
		await this.readEntries(entries, task, output)
		callbacks.pushToolResult(output.toString())
	}

	private createBatchOutput(entries: ReadFileParams[], task: Task): ReadFileBatchOutput {
		const { id: modelId, info: modelInfo } = task.api.getModel()
		const configuredReserve = getModelMaxOutputTokens({
			modelId,
			model: modelInfo,
			settings: task.apiConfiguration,
		})
		const reservedOutputTokens =
			configuredReserve && configuredReserve > 0 ? configuredReserve : ANTHROPIC_DEFAULT_MAX_TOKENS
		// Account for pending sibling results and this call's arguments, not just API metrics.
		const pendingBytes =
			Buffer.byteLength(JSON.stringify(task.userMessageContent ?? [])) +
			Buffer.byteLength(JSON.stringify(entries))
		const budget = getReadFileBatchBudget({
			contextWindow: task.api.getCondenseContextWindow?.() ?? modelInfo.contextWindow,
			contextTokens: task.getTokenUsage().contextTokens ?? 0,
			reservedOutputTokens,
			pendingBytes,
		})
		return new ReadFileBatchOutput(budget, entries.length)
	}

	private async readEntries(entries: ReadFileParams[], task: Task, output: ReadFileBatchOutput): Promise<void> {
		let stopRemainingReads = false
		for (const entry of entries) {
			const result: BatchFileResult = stopRemainingReads
				? { path: entry.path, status: "cancelled" }
				: await this.readEntry(entry, task, output.contentAllowance)

			switch (result.status) {
				case "denied":
				case "cancelled":
					stopRemainingReads = true
					break
				case "error":
				case "blocked":
				case "unsupported":
					task.didToolFailInCurrentTurn = true
					break
			}
			output.add(entry, result)
		}
	}

	private async readEntry(entry: ReadFileParams, task: Task, contentAllowance: number): Promise<BatchFileResult> {
		if (task.abort || task.abandoned) return { path: entry.path, status: "cancelled" }
		if (contentAllowance < MIN_FILE_CONTENT_BYTES) return { path: entry.path, status: "budget_exhausted" }

		try {
			const result = await this.fileReader.readEntry(this.clampReadLimits(entry), task, { textOnly: true })
			// Approval or reading may have been cancelled while the entry was in flight.
			return task.abort || task.abandoned ? { path: entry.path, status: "cancelled" } : result
		} catch (error) {
			if (task.abort || task.abandoned) return { path: entry.path, status: "cancelled" }
			return {
				path: entry.path,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			}
		}
	}

	private clampReadLimits(entry: ReadFileParams): ReadFileParams {
		return {
			...entry,
			limit: Math.min(entry.limit ?? DEFAULT_LINE_LIMIT, DEFAULT_LINE_LIMIT),
			indentation: entry.indentation
				? {
						...entry.indentation,
						max_lines: Math.min(entry.indentation.max_lines ?? DEFAULT_LINE_LIMIT, DEFAULT_LINE_LIMIT),
					}
				: undefined,
		}
	}
}
