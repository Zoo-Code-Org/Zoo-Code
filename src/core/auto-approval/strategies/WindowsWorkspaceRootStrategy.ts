import path from "path"

import type { WorkspaceRootStrategy } from "./WorkspaceRootStrategy"

/** Windows UNC roots have exactly two leading separators and nonempty server/share names. */
export const WINDOWS_UNC_PREFIX = /^\/\/([^/]+)\/+([^/]+)/

export class WindowsWorkspaceRootStrategy implements WorkspaceRootStrategy {
	/** Drop drive colons rejected by the Windows matcher while keeping UNC paths in their own namespace. */
	toMatcherAbsolutePath(absolutePath: string, workspaceVolume: string): string {
		// Keep UNC paths independent of the current drive and distinct from drive letters.
		const unc = WINDOWS_UNC_PREFIX.exec(absolutePath)
		if (unc) return `/UNC/${unc[1]}/${unc[2]}${absolutePath.slice(unc[0].length)}`

		const drive = /^([a-zA-Z]):(?=\/)/.exec(absolutePath)
		// Rooted paths belong to the workspace drive/share. Without a known volume,
		// keep them in a separate namespace so /UNC/... cannot impersonate a share.
		return drive
			? `/${drive[1]}${absolutePath.slice(drive[0].length)}`
			: `${workspaceVolume || "/ROOT"}${absolutePath.replace(/^\/+/, "/")}`
	}

	normalizeAbsoluteRoot(root: string | undefined): string | undefined {
		const normalized = (root ?? "").replace(/\\/g, "/")
		const drive = /^([a-zA-Z]):(?=\/)/.exec(normalized)
		if (!normalized.startsWith("/") && !drive) return undefined

		// Resolve parents while drives and UNC shares are still filesystem roots.
		// POSIX resolution after conversion could consume the drive or share name.
		const absolutePath = path.win32.normalize(normalized).replace(/\\/g, "/")
		return this.toMatcherAbsolutePath(absolutePath, "").replace(/\/$/, "")
	}

	comparisonKey(value: string): string {
		return value.toLowerCase()
	}
}
