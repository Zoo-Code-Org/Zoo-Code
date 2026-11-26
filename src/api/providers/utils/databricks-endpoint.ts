const DATABRICKS_HOST_SUFFIXES = [
	".databricks.com", // AWS workspaces: dbc-<id>.cloud.databricks.com
	".azuredatabricks.net", // Azure workspaces: adb-<id>.<n>.azuredatabricks.net
	".databricks.us", // GovCloud workspaces
	".azuredatabricks.us", // Azure GovCloud workspaces
] as const

/**
 * Detects Databricks model-serving endpoints from a base URL.
 *
 * Databricks validates the chat-completions body against a strict schema and
 * rejects fields outside that schema with 400 BAD_REQUEST ("Extra inputs are
 * not permitted" - issue #2168). Requests routed to one of these endpoints
 * must omit unsupported fields such as `parallel_tool_calls`.
 *
 * Covers the managed workspace hosts plus any custom gateway that proxies the
 * workspace's /serving-endpoints route by path.
 */
export function isDatabricksEndpoint(baseUrl?: string): boolean {
	if (!baseUrl) {
		return false
	}

	let url: URL
	try {
		url = new URL(baseUrl.trim())
	} catch {
		return false
	}

	const host = url.hostname.toLowerCase()
	if (DATABRICKS_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
		return true
	}

	return url.pathname.toLowerCase().includes("/serving-endpoints")
}
