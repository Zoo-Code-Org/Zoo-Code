import path from "path"

import type { WorkspaceRootStrategy } from "./WorkspaceRootStrategy"

export class WindowsWorkspaceRootStrategy implements WorkspaceRootStrategy {
	/** Drop drive colons rejected by the Windows matcher while keeping UNC paths in their own namespace. */
	toMatcherAbsolutePath(absolutePath: string, workspaceVolume: string): string {
		// Keep UNC paths independent of the current drive and distinct from drive letters.
		if (absolutePath.startsWith("//")) return `/UNC/${absolutePath.replace(/^\/+/, "")}`

		const drive = /^([a-zA-Z]):(?=\/)/.exec(absolutePath)
		// Rooted paths belong to the workspace drive/share. Without a known volume,
		// keep them in a separate namespace so /UNC/... cannot impersonate a share.
		return drive
			? `/${drive[1]}${absolutePath.slice(drive[0].length)}`
			: `${workspaceVolume || "/ROOT"}${absolutePath}`
	}

	normalizeAbsoluteRoot(root: string | undefined): string | undefined {
		const normalized = (root ?? "").replace(/\\/g, "/")
		const drive = /^([a-zA-Z]):(?=\/)/.exec(normalized)
		if (!normalized.startsWith("/") && !drive) return undefined

		// Match the allowlist representation: a Windows drive is a POSIX path segment.
		const absolutePath = this.toMatcherAbsolutePath(normalized, "")
		return path.posix.resolve(absolutePath).replace(/\/$/, "")
	}

	comparisonKey(value: string): string {
		return value.toLowerCase()
	}
}
