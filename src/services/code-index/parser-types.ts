export interface ICodeParser {
	readonly fallbackNeeded?: boolean
	fallbackContent?(filePath: string, content: string, fileHash: string): CodeBlock[]
	parseFile(
		filePath: string,
		options?: {
			minBlockLines?: number
			maxBlockLines?: number
			content?: string
			fileHash?: string
			signal?: AbortSignal
		},
	): Promise<CodeBlock[]>
}

export interface CodeBlock {
	file_path: string
	identifier: string | null
	type: string
	start_line: number
	end_line: number
	content: string
	fileHash: string
	segmentHash: string
}
