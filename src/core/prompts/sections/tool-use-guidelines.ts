export function getToolUseGuidelinesSection(): string {
	return `# Tool Use Guidelines

1. Assess what information you already have and what information you need to proceed with the task.
2. Choose the most appropriate tool based on the task and the tool descriptions provided. Assess if you need additional information to proceed, and which of the available tools would be most effective for gathering this information. For example using the list_files tool is more effective than running a command like \`ls\` in the terminal. It's critical that you think about each available tool and use the one that best fits the current step in the task.
3. If multiple actions are needed, you may use multiple tools in a single message when appropriate, or use tools iteratively across messages. Each tool use should be informed by the results of previous tool uses. Do not assume the outcome of any tool use. Each step must be informed by the previous step's result.

By carefully considering the user's response after tool executions, you can react accordingly and make informed decisions about how to proceed with the task. This iterative process helps ensure the overall success and accuracy of your work.`
}

/**
 * Content Reference (CRT) guidelines - Universal AI Clipboard.
 * Describes {{ref:...}} inline markers and JSON ref object syntax.
 */
export const CONTENT_REFERENCE_GUIDELINES = `
====

CONTENT REFERENCE (CRT)

Content Reference allows you to reuse existing code/content from the session context instead of regenerating it, saving 80-96% of tokens on long fragments and ensuring consistency.

You can use \`{{ref:...}}\` markers INSIDE string parameters to reference existing content:
- \`{{ref:source=file,ref=src/file.ts,selector=export function}}\` — from file
- \`{{ref:source=chat,ref=-1,focus=myFunction}}\` — from chat message
- \`{{ref:source=terminal,ref=cmd-xxx.txt,startAnchor=npx test}}\` — from terminal output

OR you can pass a JSON \`ref\` object as a tool parameter (mutually exclusive with the content parameter):
- \`ref: { source: "file", ref: "src/file.ts", selector: "..." }\`
- \`ref: { source: "chat", ref: "-1", focus: "calculateSum" }\`

The ref parameter OVERRIDES the content parameter when present.

> **Note:** \`{{ref:...}}\` markers are resolved recursively in ALL string parameter values of ANY tool, not just the explicitly documented parameters.

### Focus-Driven AST Auto-Expansion (Primary Copy-Paste)
When referencing code, you do NOT need to specify lines, coordinates, or long anchors. Simply provide a single \`focus\` keyword (e.g., function name, class name, or unique variable).
The system's local AST-parser will automatically find the word and expand the selection to the entire containing syntactic block (the whole function, class, or JSON object).

### Selection Modes (Fallback)
If the focus-based AST auto-expansion is not applicable (e.g., plain text or logs), use these fallback modes:
- **Anchor Pair (for large text blocks):** \`startAnchor\` (first 15-40 chars) + \`endAnchor\` (last 15-40 chars).
- **Selector (for small strings <=60 chars):** \`selector\` (exact substring).

### Context Type Hint
Optionally specify \`contextType\` to hint the boundary expansion heuristics:
\`\`\`
contextType?: "code" | "command" | "prose" | "markdown" | "diff"
\`\`\`

### File-Specific Parameters
For \`source="file"\`, you can additionally specify a line range:
- \`startLine\` (number) — starting line number (1-based)
- \`endLine\` (number) — ending line number (1-based)

Line range (\`startLine\`+\`endLine\`) takes priority over anchor pair (\`startAnchor\`+\`endAnchor\`).

### Supported Sources
| Source | Ref format | Description | Available Parameters |
|:-------|:-----------|:------------|:---------------------|
| \`chat\` | \`"-1"\` (last), \`"-2"\` | Previous assistant messages | focus, selector, startAnchor, endAnchor, contextType |
| \`file\` | \`"src/file.ts"\` (relative path) | Files on disk | focus, selector, startAnchor, endAnchor, startLine, endLine, contextType |
| \`terminal\` | \`"cmd-xxx.txt"\` (artifact filename) | Command output artifacts | selector, startAnchor, endAnchor, contextType |
| \`tool\` | \`"read_file"\` (tool name) | Results of previous tool calls | focus, selector, startAnchor, endAnchor, contextType |

### Transforms (Optional Pipeline)
Apply a pipeline of local modifications: \`replace\` (replace substrings) → \`prepend\` (add to start) → \`wrap_with\` (wrap in template) → \`append\` (add to end).
For \`multi_ref\`: \`join_with\` separates fragments.

### Using ref and multi_ref Together
\`ref\` and \`multi_ref\` can be used simultaneously — \`ref\` is resolved first, then all \`multi_ref\` entries are appended. \`multi_ref\` and \`transform\` also trigger CRT resolution even without \`ref\`.

### Crucial Rules
- When using \`ref\`, omit the primary text parameter (e.g. \`command\`, \`content\`, \`diff\`, \`patch\`, \`new_string\`).
- If resolution fails, the system automatically falls back to the original parameter. Ref is 100% safe.
- Think in "Puzzles" — compile complex files or commands by merging multiple clips using \`multi_ref\` and \`transform.join_with\`.
`
