import path from "path"

import type { WorkspaceRootStrategy } from "./WorkspaceRootStrategy"

export class PosixWorkspaceRootStrategy implements WorkspaceRootStrategy {
	toMatcherAbsolutePath(absolutePath: string): string {
		return absolutePath
	}

	normalizeAbsoluteRoot(root: string | undefined): string | undefined {
		if (!root?.startsWith("/")) return undefined

		return path.posix.resolve(this.toMatcherAbsolutePath(root)).replace(/\/$/, "")
	}

	comparisonKey(value: string): string {
		return value
	}
}
