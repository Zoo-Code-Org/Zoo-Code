import type { EffectiveToolPolicy } from "../tools/effective-tool-policy"

/**
 * Builds the CAPABILITIES section of the system prompt.
 *
 * Every capability claim is now a fragment emitted only when its tool is in the
 * request's effective tool policy (the single source of truth shared by prompt
 * generation, API tool construction, runtime validation, and preview). This
 * keeps the prose consistent with what the model can actually call for the mode.
 *
 * The file-tree paragraph is stated once as a fact in SYSTEM INFORMATION; the
 * `list_files` *guidance* lives here and is gated on the tool being present.
 *
 * @param policy The request's effective tool policy.
 */
export function getCapabilitiesSection(policy: EffectiveToolPolicy): string {
	const tools = policy.tools

	const clauses: string[] = []
	if (tools.has("execute_command")) {
		clauses.push("execute CLI commands on the user's computer")
	}
	if (tools.has("list_files")) {
		clauses.push("list files")
	}
	if (tools.has("codebase_search")) {
		clauses.push("view source code definitions")
	}
	if (tools.has("search_files")) {
		clauses.push("regex search")
	}
	if (tools.has("read_file")) {
		clauses.push("read files")
	}
	if (tools.has("write_to_file") || tools.has("apply_diff")) {
		clauses.push("write and edit files")
	}

	// The catalog clause is the only always-present sentence; when there are no
	// per-tool clauses (e.g. a control-tool-only mode) we fall back to a sentence
	// that warns the model it may only call provided tools.
	const capabilitySentence =
		clauses.length > 0
			? `You have access to tools that let you ${clauses.join(", ")}.`
			: "You have access to a limited set of tools for this mode; only the tools you are provided may be called."

	// The edit-restriction suffix binds to the capability sentence (not the last
	// emitted bullet) so its position is deterministic regardless of which
	// optional bullets follow.
	const editRestrictionSuffix = policy.editRestriction
		? ` (in this mode only files matching '${policy.editRestriction.fileRegex}' can be edited${
				policy.editRestriction.description ? ` — ${policy.editRestriction.description}` : ""
			})`
		: ""

	let body = `${capabilitySentence}${editRestrictionSuffix}\n`

	body += `- These tools help you accomplish tasks.\n`

	// `list_files` guidance only — the file-tree *fact* is stated once in
	// SYSTEM INFORMATION (and carries the cwd there).
	if (tools.has("list_files")) {
		body += `- If you need to further explore directories such as outside the current workspace directory, you can use the list_files tool. If you pass 'true' for the recursive parameter, it will list files recursively. Otherwise, it will list files at the top level, which is better suited for generic directories where you don't necessarily need the nested structure, like the Desktop.\n`
	}

	if (tools.has("execute_command")) {
		body += `- You can use the execute_command tool to run commands on the user's computer whenever you feel it can help accomplish the user's task. When you need to execute a CLI command, you must provide a clear explanation of what the command does. Prefer to execute complex CLI commands over creating executable scripts, since they are more flexible and easier to run. Interactive and long-running commands are allowed, since the commands are run in the user's VSCode terminal. The user may keep commands running in the background and you will be kept updated on their status along the way. Each command you execute is run in a new terminal instance.\n`
	}

	// MCP bullet — only when MCP is effectively available (group + enabled tools/resources).
	if (policy.hasMcpGroup && (policy.hasMcpTools || policy.hasMcpResources)) {
		body += `- You have access to MCP servers that may provide additional tools and/or resources actually available to this mode. Each server may provide different capabilities that you can use to accomplish tasks more effectively.\n`
	}

	body = body.replace(/\n$/, "")

	return `====

CAPABILITIES

${body}`
}
