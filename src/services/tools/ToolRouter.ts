import { createHash } from "node:crypto"
import { buildMcpToolName } from "../../utils/mcp-name"
import type { McpHub } from "../mcp/McpHub"
import { createRanker } from "./index"
import type { Ranker, ToolDoc } from "./types"

/** Process-wide routing cache. Only caller-scoped tools are ever ranked. */
export class ToolRouter {
	private static instance: ToolRouter | undefined
	private ranker?: Ranker
	private indexedTools?: { key: string; tools: ToolDoc[] }

	private constructor() {}

	static getInstance(): ToolRouter {
		return (this.instance ??= new ToolRouter())
	}

	/** The hub owns this subscription and disposes it with its other resources. */
	registerHub(hub: Pick<McpHub, "onServerListChanged">): { dispose(): void } {
		return hub.onServerListChanged(() => this.invalidate())
	}

	private invalidate(): void {
		this.indexedTools = undefined
		this.ranker = undefined
	}

	async attachInitial(taskText: string, scopedTools: ToolDoc[], k: number): Promise<string[]> {
		return this.search(taskText, scopedTools, k)
	}

	async search(query: string, scopedTools: ToolDoc[], k: number): Promise<string[]> {
		// Top-K requires a finite positive limit; fractional limits round down.
		if (scopedTools.length === 0 || !query.trim() || !Number.isFinite(k) || k < 1) {
			return []
		}

		// Content keys allow equivalent caller arrays to share the index while
		// keeping task scopes and changed tool descriptions isolated.
		const key = createHash("sha256").update(JSON.stringify(scopedTools)).digest("hex")
		if (this.indexedTools?.key !== key) {
			// Canonical names can collide after sanitizing or truncating. Keep the
			// first tool per name before ranking so collisions do not use Top-K slots.
			const unique = new Map<string, ToolDoc>()
			for (const tool of scopedTools) {
				const name = buildMcpToolName(tool.serverName, tool.toolName)
				if (!unique.has(name)) {
					unique.set(name, { ...tool })
				}
			}
			this.indexedTools = { key, tools: [...unique.values()] }
		}
		this.ranker ??= createRanker()
		const ranked = await this.ranker.rank(query, this.indexedTools.tools, Math.floor(k))
		return ranked.map((tool) => buildMcpToolName(tool.serverName, tool.toolName))
	}
}
