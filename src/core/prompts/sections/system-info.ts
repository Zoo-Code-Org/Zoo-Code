import os from "os"
import osName from "os-name"

import { getShell } from "../../../utils/shell"
import type { ResolvedCommandEnvironment } from "../../../integrations/terminal/shell/types"

/**
 * Renders the SYSTEM INFORMATION section of the system prompt.
 *
 * When a {@link ResolvedCommandEnvironment} is provided, the shell information
 * is rendered from the resolved environment snapshot — the same snapshot used
 * by runtime execution and the native tool description. This is the single
 * source of truth (ARCH-TERMINAL-001, issue #634).
 *
 * When no environment is provided (legacy callers), falls back to `getShell()`.
 *
 * @param cwd The current workspace directory.
 * @param env Optional resolved command environment snapshot.
 */
export function getSystemInfoSection(cwd: string, env?: ResolvedCommandEnvironment): string {
	// Try to get detailed OS name, fall back to basic info if it fails
	let osInfo: string
	try {
		osInfo = osName()
	} catch (error) {
		// Fallback when os-name fails (e.g., PowerShell not available on Windows)
		const platform = os.platform()
		const release = os.release()
		osInfo = `${platform} ${release}`
	}

	// Build the shell information block from the resolved environment when
	// available. This ensures the prompt matches the shell that actually
	// executes the model's commands.
	let shellInfo: string
	if (env) {
		const d = env.promptDescriptor
		shellInfo = [
			`Default Shell: ${d.shellFamilyLabel} (${d.shellExecutableName})`,
			`Command Execution Provider: ${d.providerLabel}`,
			`Shell Resolution Source: ${d.sourceLabel}`,
			`Shell Constraints: ${d.isNonInteractive ? "Non-interactive" : "Interactive"}`,
		].join("\n")
	} else {
		shellInfo = `Default Shell: ${getShell()}`
	}

	const details = `====

SYSTEM INFORMATION

Operating System: ${osInfo}
${shellInfo}
Home Directory: ${os.homedir().toPosix()}
Current Workspace Directory: ${cwd.toPosix()}

The Current Workspace Directory is the active VS Code project directory, and is therefore the default directory for all tool operations. New terminals will be created in the current workspace directory, however if you change directories in a terminal it will then have a different working directory; changing directories in a terminal does not modify the workspace directory, because you do not have access to change the workspace directory. When the user initially gives you a task, a recursive list of all filepaths in the current workspace directory ('/test/path') will be included in environment_details. This provides an overview of the project's file structure, offering key insights into the project from directory/file names (how developers conceptualize and organize their code) and file extensions (the language used). This can also guide decision-making on which files to explore further. If you need to further explore directories such as outside the current workspace directory, you can use the list_files tool. If you pass 'true' for the recursive parameter, it will list files recursively. Otherwise, it will list files at the top level, which is better suited for generic directories where you don't necessarily need the nested structure, like the Desktop.`

	return details
}
