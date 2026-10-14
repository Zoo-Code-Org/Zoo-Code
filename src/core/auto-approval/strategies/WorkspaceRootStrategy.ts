import { PosixWorkspaceRootStrategy } from "./PosixWorkspaceRootStrategy"
import { WindowsWorkspaceRootStrategy } from "./WindowsWorkspaceRootStrategy"

export abstract class WorkspaceRootStrategy {
	static forPlatform(isWindows: boolean): WorkspaceRootStrategy {
		return isWindows ? new WindowsWorkspaceRootStrategy() : new PosixWorkspaceRootStrategy()
	}

	/** Convert a slash-normalized absolute path into the matcher's platform-specific namespace. */
	abstract toMatcherAbsolutePath(absolutePath: string, workspaceVolume: string): string
	abstract normalizeAbsoluteRoot(root: string | undefined): string | undefined
	abstract comparisonKey(value: string): string
}
