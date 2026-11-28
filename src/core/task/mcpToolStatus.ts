import deepEqual from "fast-deep-equal"
import type { McpToolStatus } from "@roo-code/types"

/** Holds the result of the newest tool build. An older build cannot replace it. */
export class McpToolStatusTracker {
	/** `null` means that the build declares all allowed MCP tools. */
	value: McpToolStatus | null = null
	private newestBuild = 0

	constructor(private readonly onChange: () => void) {}

	/** Call at the start of a build. Call the returned function with its result. */
	begin(): (status: McpToolStatus | null) => void {
		const build = ++this.newestBuild
		return (status) => {
			if (build !== this.newestBuild || deepEqual(status, this.value)) return
			this.value = status
			this.onChange()
		}
	}
}
