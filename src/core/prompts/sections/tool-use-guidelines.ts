export function getToolUseGuidelinesSection(): string {
	return `# Tool Use Guidelines

1. Assess what information you already have and what information you need to proceed with the task.
2. Choose the most appropriate tool based on the task and the tool descriptions provided. Assess if you need additional information to proceed, and which of the available tools would be most effective for gathering this information. For example using the list_files tool is more effective than running a command like \`ls\` in the terminal. It's critical that you think about each available tool and use the one that best fits the current step in the task.
3. If multiple actions are needed, you may use multiple tools in a single message when appropriate, or use tools iteratively across messages. Each tool use should be informed by the results of previous tool uses. Do not assume the outcome of any tool use. Each step must be informed by the previous step's result.

By carefully considering the user's response after tool executions, you can react accordingly and make informed decisions about how to proceed with the task. This iterative process helps ensure the overall success and accuracy of your work.`
}

/**
 * Content Reference (CRT) guidelines - aggressive token efficiency.
 * Ref is the DEFAULT mechanism, not an alternative.
 */
export const CONTENT_REFERENCE_GUIDELINES = `
Before writing content for any tool that accepts it (execute_command, write_to_file,
apply_diff, apply_patch, edit, search_and_replace, search_replace, edit_file),
first check: does the exact content already exist somewhere in the session context
— a previous assistant message, a file on disk, a terminal artifact, or a tool result?

If yes → use \`ref\` instead of regenerating it. Ref saves 80-96% of tokens per
fragment, making responses faster and tasks cheaper.

### How to reference
| Fragment size | Mechanism | Example ref |
|:-------------|:-----------|:------------|
| >60 chars | \`startAnchor\` + \`endAnchor\` (15-40 chars each) | \`{ source: "chat", ref: "-1", startAnchor: "function foo(", endAnchor: "}" }\` |
| ≤60 chars | \`selector\` (exact substring) | \`{ source: "chat", ref: "-1", selector: "export const API" }\` |
| Multiple sources | \`multi_ref\` + \`transform.join_with\` | \`{ multi_ref: [...], transform: { join_with: "\\\\n" } }\` |
| MCP tools | Inline \`{{ref:...}}\` markers | \`{{ref:source=chat,ref=-1,startAnchor=function foo(}}\` |

### Supported sources
| Source | Ref format | Purpose |
|--------|-----------|---------|
| \`chat\` | \`"-1"\` (last), \`"-2"\` | Previous assistant messages |
| \`file\` | \`"src/file.ts"\` (relative path) | Files on disk |
| \`terminal\` | \`"cmd-xxx.txt"\` (artifact filename) | Command output artifacts |
| \`tool\` | \`"read_file"\` (tool name) | Results of previous tool calls |

### Transforms (optional pipeline)
Order: \`replace → prepend → wrap_with → append\`. For multi_ref: \`join_with\` separates fragments.

### Why ref first
- Ref is **safe**: if resolution fails, the system automatically falls back to the original parameter. You break nothing by using ref.
- When using ref, omit the parameter it replaces (command, content, diff, patch, new_string). Do NOT pass both.
- Start with \`ref\` — only regenerate when the content is truly new or unique.
`
