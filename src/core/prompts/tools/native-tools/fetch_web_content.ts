import type OpenAI from "openai"

const FETCH_WEB_CONTENT_DESCRIPTION = `Request to fetch content from a URL on the web. This tool retrieves the content of a web page or API endpoint and returns it as text.

Use this tool when you need to:
- Read documentation from a URL
- Fetch API responses
- Get content from web pages
- Download text-based resources

The tool will automatically:
- Convert HTML to readable text (stripping scripts, styles, and tags)
- Pretty-print JSON responses
- Enforce size limits and timeouts for safety

Parameters:
- url: (required) The URL to fetch. Must use http:// or https:// protocol.
- prompt: (optional) A description of what information you're looking for. This helps focus the analysis of the fetched content.

Example: Fetching documentation
{ "url": "https://docs.example.com/api/reference", "prompt": "Find the authentication methods" }

Example: Fetching an API response
{ "url": "https://api.example.com/status", "prompt": null }`

const URL_PARAMETER_DESCRIPTION = `The URL to fetch content from. Must use http:// or https:// protocol.`

const PROMPT_PARAMETER_DESCRIPTION = `Optional description of what information to look for in the fetched content. Helps focus analysis.`

export default {
	type: "function",
	function: {
		name: "fetch_web_content",
		description: FETCH_WEB_CONTENT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: URL_PARAMETER_DESCRIPTION,
				},
				prompt: {
					type: ["string", "null"],
					description: PROMPT_PARAMETER_DESCRIPTION,
				},
			},
			required: ["url", "prompt"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
