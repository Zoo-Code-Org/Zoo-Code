import type OpenAI from "openai"
import { MAX_READ_FILES, READ_FILES_TOOL_NAME } from "@roo-code/types"
import { createReadFileParameters } from "./file-reading/readFileParameters"

export default {
	type: "function",
	function: {
		name: READ_FILES_TOOL_NAME,
		strict: true,
		description: `Read 1-${MAX_READ_FILES} already-known independent files in ONE native tool call, sequentially, with individual slice/indentation parameters and approvals. Prefer read_file when the next path depends on an earlier result. Text and extracted documents (PDF, DOCX, notebooks) only; images and unsupported binary formats are explicitly rejected (use read_file for images). Line-number prefixes are not part of the raw file. The complete batch shares a context-aware budget with reserved output, a safety margin, and an absolute 64 KiB ceiling; explicit line limits cannot bypass it. Every entry is reported in request order, including errors, denials, clipping and unread budget-exhausted entries. Rejection/cancellation stops remaining reads; completed siblings are preserved. Follow per-entry continuation guidance rather than rereading from line 1. Optional parameters can be omitted, or set to null on strict providers.`,
		parameters: {
			type: "object",
			properties: {
				entries: {
					type: "array",
					minItems: 1,
					maxItems: MAX_READ_FILES,
					description: "Independent reads in stable result order; each uses the read_file parameters.",
					items: createReadFileParameters({ strictOptionalFields: true }),
				},
			},
			required: ["entries"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
