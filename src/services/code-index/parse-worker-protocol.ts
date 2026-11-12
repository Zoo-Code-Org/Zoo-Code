import type { CodeIndexLogLevel } from "./code-index-log"
import type { CodeBlock } from "./parser-types"

export interface ParseRequest {
	id: number
	filePath: string
	content: string
	fileHash: string
}

export interface ParseReply {
	id: number
	blocks?: CodeBlock[]
	fallback?: boolean
	error?: { message: string; fatal: boolean }
	diagnostic?: { level: CodeIndexLogLevel; message: string; fields?: unknown }
}
