import path from "path"

import type { ApprovalFileTarget } from "../../../shared/tools"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"

/**
 * Resolve the file a tool will access into the target auto-approval checks.
 *
 * Tools must access the returned `absolutePath`, so that the permission check
 * and the filesystem operation agree on the file.
 */
export function resolveApprovalFileTarget(cwd: string, relPath: string): ApprovalFileTarget {
	const absolutePath = path.resolve(cwd, relPath)

	return { absolutePath, isOutsideWorkspace: isPathOutsideWorkspace(absolutePath) }
}
