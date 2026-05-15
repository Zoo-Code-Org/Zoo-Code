import { pathToFileURL } from "url"

export const INDEXING_PLUGIN = "@zoo-code/indexing-disabled"

function hasIndexingPlugin(items: readonly PluginSpec[]): boolean {
	return items.some((item) => (typeof item === "string" ? item : item[0]) === INDEXING_PLUGIN)
}

// RATIONALE: Upstream PluginSpec changed from string to string | [string, Record].
// Use a broad input type to accept both forms but return the concrete PluginSpec shape.
type PluginSpec = string | [string, Record<string, unknown>]

type ConfigLike = {
	plugin?: readonly PluginSpec[] | null
	experimental?: { semantic_indexing?: boolean } | null
}

type Req = {
	resolve: (id: string) => string
}

type LogLike = {
	debug: (msg: string, data?: Record<string, unknown>) => void
}

export function indexingEnabled(config?: ConfigLike | null): boolean {
	return hasIndexingPlugin(config?.plugin ?? []) && config?.experimental?.semantic_indexing === true
}

export function resolveIndexingPlugin(req: Req, log?: LogLike): string {
	try {
		const file = req.resolve(INDEXING_PLUGIN)
		return pathToFileURL(file).href
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err)
		log?.debug("failed to resolve indexing plugin package, using package marker", { error })
		return INDEXING_PLUGIN
	}
}

export function ensureIndexingPlugin(items: readonly PluginSpec[], plugin?: string): PluginSpec[] {
	const plugins = [...items]
	if (!plugin) return plugins
	if (hasIndexingPlugin(plugins)) return plugins
	return [...plugins, plugin]
}
