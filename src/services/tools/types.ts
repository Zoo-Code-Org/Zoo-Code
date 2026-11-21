export type ToolDoc = {
	serverName: string
	toolName: string
	description: string
}

export interface Ranker {
	rank(query: string, items: ToolDoc[], k: number): ToolDoc[]
}
