import type { Anthropic } from "@anthropic-ai/sdk"
import { resolveMcpDynamicLoadSettings } from "@roo-code/types"
import { ToolRouter } from "../../services/tools/ToolRouter"
import type { ToolDoc } from "../../services/tools/types"
import { buildMcpToolName, isMcpTool, normalizeMcpToolName } from "../../utils/mcp-name"

/** Task selections grow across scope changes. Only current declarations decide availability. */
export class McpToolSelection {
	readonly names: Set<string>
	initialized: boolean
	private pending?: Promise<void>

	constructor(
		savedNames?: string[],
		private readonly rank: (query: string, scope: ToolDoc[], k: number) => Promise<string[]> = (query, scope, k) =>
			ToolRouter.getInstance().attachInitial(query, scope, k),
	) {
		this.names = new Set(savedNames)
		this.initialized = savedNames !== undefined
	}

	async initialize(
		scope: ToolDoc[],
		initialK: number,
		taskText: string,
		history: Anthropic.MessageParam[],
		persist: () => Promise<void>,
	): Promise<void> {
		// Each caller must check its own scope after a preceding caller completes.
		while (this.pending) await this.pending
		this.pending = this.select(scope, initialK, taskText.trim(), history, persist)
		try {
			await this.pending
		} finally {
			this.pending = undefined
		}
	}

	private async select(
		scope: ToolDoc[],
		initialK: number,
		taskText: string,
		history: Anthropic.MessageParam[],
		persist: () => Promise<void>,
	): Promise<void> {
		const available = new Set(scope.map((tool) => buildMcpToolName(tool.serverName, tool.toolName)))
		// A saved empty selection is deliberate. A nonempty selection must still
		// contain an available name before it can skip ranking in this scope.
		const needsRanking =
			!this.initialized || (this.names.size > 0 && ![...this.names].some((n) => available.has(n)))
		const additions = new Set<string>()
		for (const message of history) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue
			for (const block of message.content) {
				if (block.type === "tool_use" && typeof block.name === "string" && isMcpTool(block.name)) {
					additions.add(normalizeMcpToolName(block.name))
				}
			}
		}
		if (needsRanking) {
			const { initialK: limit } = resolveMcpDynamicLoadSettings(undefined, initialK)
			const selected = taskText ? await this.rank(taskText, scope, limit) : [...available].slice(0, limit)
			for (const name of selected) additions.add(name)
			if (additions.size === 0 && (!taskText || available.size === 0)) return
		}
		const changed = !this.initialized || [...additions].some((name) => !this.names.has(name))
		for (const name of additions) this.names.add(name)
		this.initialized = true
		if (changed) await persist()
	}
}
