import path from "path"

/**
 * Generates a relative file path from a normalized absolute path and workspace root.
 * Ensures consistent relative path generation across different platforms.
 *
 * @param normalizedAbsolutePath - The normalized absolute path to convert
 * @param workspaceRoot - The root directory of the workspace (required)
 * @returns The relative path from workspaceRoot to the file
 */
export function generateRelativeFilePath(normalizedAbsolutePath: string, workspaceRoot: string): string {
	// Generate the relative path
	const relativePath = path.relative(workspaceRoot, normalizedAbsolutePath)
	// Normalize to ensure consistent path separators
	return path.normalize(relativePath)
}
