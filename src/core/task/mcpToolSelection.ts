import { MAX_ATTACHED_DURING_ROLLING, resolveMcpDynamicLoadSettings } from "@roo-code/types"
import { ToolRouter } from "../../services/tools/ToolRouter"
import type { ToolDoc } from "../../services/tools/types"
import { buildMcpToolName, isMcpTool, normalizeMcpToolName } from "../../utils/mcp-name"
import { resolveMcpToolFromCatalog } from "../prompts/tools/native-tools/mcp_server"
import type { ApiMessage } from "../task-persistence/apiMessages"

const SUPPLEMENTAL_K = 7
const USER_MESSAGE_TAG = "<user_message>"

type RankFn = (query: string, scope: ToolDoc[], k: number) => Promise<string[]>

export interface McpSelectionLimits {
	initialK: number
	searchTurns: number
}

interface CatalogEntry {
	name: string
	serverName: string
	tool: { name: string }
}

/** Spec: McpToolSelectionLifecycle. Only current declarations decide availability. */
export class McpToolSelection {
	readonly names: Set<string>
	initialized: boolean
	private pending?: Promise<void>
	private lastRankedQuery = ""

	constructor(
		savedNames?: string[],
		private readonly rank: RankFn = (query, scope, k) => ToolRouter.getInstance().attachInitial(query, scope, k),
	) {
		this.names = new Set(savedNames)
		this.initialized = savedNames !== undefined
	}

	/** Spec: Condense. The next select runs a full rank. */
	reset(): void {
		this.names.clear()
		this.initialized = false
	}

	async initialize(
		scope: ToolDoc[],
		limits: McpSelectionLimits,
		taskText: string,
		history: ApiMessage[],
		persist: () => Promise<void>,
	): Promise<void> {
		while (this.pending) await this.pending
		this.pending = this.select(scope, limits, taskText.trim(), history, persist)
		try {
			await this.pending
		} finally {
			this.pending = undefined
		}
	}

	private async select(
		scope: ToolDoc[],
		limits: McpSelectionLimits,
		taskText: string,
		history: ApiMessage[],
		persist: () => Promise<void>,
	): Promise<void> {
		const catalog = buildCatalog(scope)
		const available = new Set(catalog.map((entry) => entry.name))
		if (available.size === 0 && !this.initialized) return

		const additions = new Set<string>()
		recoverSinceLastSummary(additions, catalog, history)

		const scopeOverlaps = this.names.size === 0 || [...this.names].some((n) => available.has(n))
		const fullRank = !this.initialized || !scopeOverlaps
		const query = latestUserText(history) || (fullRank ? taskText : "")
		const { initialK, searchTurns } = resolveMcpDynamicLoadSettings(undefined, limits.initialK, limits.searchTurns)
		const supplement =
			!fullRank &&
			query !== "" &&
			query !== this.lastRankedQuery &&
			userTurnsSinceLastSummary(history) <= searchTurns
		if (fullRank || supplement) {
			const k = fullRank ? initialK : this.supplementalK()
			const candidates = fullRank ? scope : scope.filter((tool) => !this.names.has(toolName(tool)))
			if (k > 0) for (const name of await this.rankCandidates(candidates, query, k)) additions.add(name)
			this.lastRankedQuery = query
		}

		const hasNewAdditions = [...additions].some((name) => !this.names.has(name))
		if (!hasNewAdditions && this.initialized) return

		for (const name of additions) this.names.add(name)
		this.initialized = true
		await persist()
	}

	/** Spec: CapTo. The room is 0 when initialK already exceeds the cap. */
	private supplementalK(): number {
		const room = Math.max(0, MAX_ATTACHED_DURING_ROLLING - this.names.size)
		if (room < SUPPLEMENTAL_K) {
			console.warn(
				`[McpToolSelection] Attach cap ${MAX_ATTACHED_DURING_ROLLING} reached; supplement limited to ${room}`,
			)
		}
		return Math.min(SUPPLEMENTAL_K, room)
	}

	/** Spec: InitialRank ranks the whole scope. SupplementalRank ranks the unselected tools. */
	private async rankCandidates(candidates: ToolDoc[], query: string, k: number): Promise<string[]> {
		if (candidates.length === 0) return []
		if (query) return this.rank(query, candidates, k)
		return [...new Set(candidates.map(toolName))].slice(0, k)
	}
}

const toolName = (tool: ToolDoc) => buildMcpToolName(tool.serverName, tool.toolName)

function buildCatalog(scope: ToolDoc[]): CatalogEntry[] {
	return scope.map((tool) => ({
		name: toolName(tool),
		serverName: tool.serverName,
		tool: { name: tool.toolName },
	}))
}

/** Re-resolves tool names from tool_use blocks the model still sees after the last condensation. */
function recoverSinceLastSummary(additions: Set<string>, catalog: CatalogEntry[], history: ApiMessage[]): void {
	for (let i = history.length - 1; i >= 0 && !history[i].isSummary; i--) {
		const message = history[i]
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (block.type === "tool_use" && typeof block.name === "string" && isMcpTool(block.name)) {
				const resolved = resolveMcpToolFromCatalog(catalog, block.name)
				additions.add(resolved?.name ?? normalizeMcpToolName(block.name))
			}
		}
	}
}

/** userInputContent tags user-typed text. Tool results and environment details do not carry the tag. */
function latestUserText(history: ApiMessage[]): string {
	for (let i = history.length - 1; i >= 0; i--) {
		const text = history[i].isSummary ? undefined : userText(history[i])
		if (text) return text
	}
	return ""
}

/** Spec: InWindow. The task message counts as turn 1. No counter is stored, so a reload keeps the count. */
function userTurnsSinceLastSummary(history: ApiMessage[]): number {
	let turns = 0
	for (let i = history.length - 1; i >= 0 && !history[i].isSummary; i--) {
		if (userText(history[i])) turns++
	}
	return turns
}

function userText(message: ApiMessage): string | undefined {
	if (message.role !== "user") return undefined
	return blockTexts(message.content)
		.filter((text) => text.includes(USER_MESSAGE_TAG))
		.pop()
		?.trim()
}

function blockTexts(content: ApiMessage["content"]): string[] {
	if (typeof content === "string") return [content]
	return content.flatMap((block) => {
		if (block.type === "text") return [block.text]
		if (block.type !== "tool_result" || block.content === undefined) return []
		if (typeof block.content === "string") return [block.content]
		return block.content.flatMap((inner) => (inner.type === "text" ? [inner.text] : []))
	})
}
