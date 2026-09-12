import os from "os"
import osName from "os-name"

import { getShell } from "../../../utils/shell"

import type { EffectiveToolPolicy } from "../tools/effective-tool-policy"

/**
 * Builds the SYSTEM INFORMATION section of the system prompt.
 *
 * The workspace-directory / file-tree facts are stated once here; the
 * file-tree fact is cwd-independent. The terminal-cd sentence is gated on
 * `execute_command`, since those semantics do not exist without it.
 *
 * @param cwd Current working directory used in the prompt text.
 * @param policy The request's effective tool policy.
 */
export function getSystemInfoSection(cwd: string, policy: EffectiveToolPolicy): string {
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

	const executeCommandAvailable = policy.tools.has("execute_command")

	const executeCommandSentence = executeCommandAvailable
		? " New terminals will be created in the current workspace directory, however if you change directories in a terminal it will then have a different working directory; changing directories in a terminal does not modify the workspace directory, because you do not have access to change the workspace directory."
		: ""

	const details = `====

SYSTEM INFORMATION

Operating System: ${osInfo}
Default Shell: ${getShell()}
Home Directory: ${os.homedir().toPosix()}
Current Workspace Directory: ${cwd.toPosix()}

The Current Workspace Directory is the active VS Code project directory, and is therefore the default directory for all tool operations.${executeCommandSentence} When the user initially gives you a task, a recursive list of all filepaths in the current workspace directory will be included in environment_details. This provides an overview of the project's file structure, offering key insights into the project from directory/file names (how developers conceptualize and organize their code) and file extensions (the language used). This can also guide decision-making on which files to explore further.`

	return details
}
