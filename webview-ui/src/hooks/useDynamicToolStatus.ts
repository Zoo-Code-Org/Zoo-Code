import { useExtensionState } from "@src/context/ExtensionStateContext"

/** The MCP declarations of the newest tool build of the current task. */
export function useDynamicToolStatus() {
	const { mcpToolStatus } = useExtensionState()
	const attachedToolNames = mcpToolStatus?.attachedToolNames ?? []

	return {
		mode: mcpToolStatus ? ("dynamic" as const) : ("all" as const),
		attachedToolNames,
		attachedCount: attachedToolNames.length,
		totalScoped: mcpToolStatus?.totalScoped ?? 0,
	}
}
