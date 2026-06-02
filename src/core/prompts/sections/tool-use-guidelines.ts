export function getToolUseGuidelinesSection(): string {
	return `# Tool Use Guidelines

1. Assess what information you already have and what information you need to proceed with the task.
2. Choose the most appropriate tool based on the task and the tool descriptions provided. Assess if you need additional information to proceed, and which of the available tools would be most effective for gathering this information. For example using the list_files tool is more effective than running a command like \`ls\` in the terminal. It's critical that you think about each available tool and use the one that best fits the current step in the task.
3. If multiple actions are needed, you may use multiple tools in a single message when appropriate, or use tools iteratively across messages. Each tool use should be informed by the results of previous tool uses. Do not assume the outcome of any tool use. Each step must be informed by the previous step's result.

By carefully considering the user's response after tool executions, you can react accordingly and make informed decisions about how to proceed with the task. This iterative process helps ensure the overall success and accuracy of your work.`
}

/**
 * Content Reference (CRT) guidelines.
 *
 * CRT allows the agent to cite existing content from session context
 * instead of regenerating it, saving 80-96% tokens on long fragments.
 */
export const CONTENT_REFERENCE_GUIDELINES = `
## Content Reference (Ref)

You can use \`ref\` parameters to cite content already present in the session context, avoiding redundant generation:

### When to use Ref
- **Long fragments (>60 chars):** Use \`startAnchor\` + \`endAnchor\` (15-40 chars each)
  The Selector Engine finds everything between them automatically.
  Example: \`{ ref: { source: "chat", ref: "-1", startAnchor: "function foo(", endAnchor: "}" } }\`
- **Short fragments (<=60 chars):** Use \`selector\` (exact substring)
  Example: \`{ ref: { source: "file", ref: "src/config.ts", selector: "export const API_URL" } }\`
- **Multi-source composition:** Use \`multi_ref\` with \`join_with\` separator
  Example: \`{ multi_ref: [...], transform: { join_with: "\\\\n" } }\`
- **MCP tools:** Use inline \`{{ref:source=chat,ref=-1,startAnchor=...}}\` markers inside strings

### Supported Sources
| Source | Ref format | Description |
|--------|-----------|-------------|
| \`chat\` | \`"-1"\` (last message), \`"-2"\` | Previous assistant messages |
| \`file\` | \`"src/file.ts"\` (relative path) | Files on disk |
| \`terminal\` | \`"cmd-xxx.txt"\` (artifact) | Command outputs |
| \`tool\` | \`"read_file"\` (tool name) | Results of previous tool calls |

### Transforms (optional pipeline)
Order: \`replace → prepend → wrap_with → append\`
- \`replace\`: { from: "old", to: "new" } — substring replacement
- \`prepend\`: "text before" — add before content
- \`wrap_with\`: "template {content}" — wrap with template
- \`append\`: "text after" — add after content

### Important
- \`ref\` is OPTIONAL. If omitted, the tool works as usual.
- If ref fails (content condensed, file changed), the content is regenerated automatically.
- Do NOT use both \`command\` and \`ref\` in the same call — ref has priority.
`
