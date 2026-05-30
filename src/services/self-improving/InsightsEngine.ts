import { randomUUID } from "node:crypto"
import * as path from "node:path"
import * as fs from "node:fs/promises"

export interface SessionInsight {
	id: string
	sessionId: string
	type: "token_usage" | "tool_usage" | "cost_estimate" | "error_pattern" | "performance"
	timestamp: number
	data: Record<string, unknown>
	summary: string
}

export interface InsightsReport {
	sessionId: string
	startTime: number
	endTime: number
	totalTokens: number
	totalCost: number
	toolUsageCount: number
	errorCount: number
	topTools: Array<{ name: string; count: number }>
	insights: SessionInsight[]
}

export class InsightsEngine {
	private insights: SessionInsight[] = []
	private sessionId: string
	private storagePath: string
	private startTime: number
	private toolUsageCounts: Map<string, number> = new Map()
	private errorCount = 0
	private totalTokens = 0
	private totalCost = 0

	constructor(storagePath: string) {
		this.sessionId = randomUUID()
		this.storagePath = path.join(storagePath, "insights")
		this.startTime = Date.now()
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.storagePath, { recursive: true })
	}

	recordToolUsage(toolName: string, tokens?: number, cost?: number): void {
		this.toolUsageCounts.set(toolName, (this.toolUsageCounts.get(toolName) || 0) + 1)
		if (tokens) {
			this.totalTokens += tokens
		}

		if (cost) {
			this.totalCost += cost
		}

		this.insights.push({
			id: randomUUID(),
			sessionId: this.sessionId,
			type: "tool_usage",
			timestamp: Date.now(),
			data: { toolName, tokens, cost },
			summary: `Tool "${toolName}" used`,
		})
	}

	recordError(errorType: string, details?: string): void {
		this.errorCount++
		this.insights.push({
			id: randomUUID(),
			sessionId: this.sessionId,
			type: "error_pattern",
			timestamp: Date.now(),
			data: { errorType, details },
			summary: `Error: ${errorType}${details ? ` - ${details}` : ""}`,
		})
	}

	recordTokenUsage(tokens: number, cost: number, context: string): void {
		this.totalTokens += tokens
		this.totalCost += cost
		this.insights.push({
			id: randomUUID(),
			sessionId: this.sessionId,
			type: "token_usage",
			timestamp: Date.now(),
			data: { tokens, cost, context },
			summary: `Used ${tokens} tokens ($${cost.toFixed(4)}) for ${context}`,
		})
	}

	recordPerformance(operation: string, durationMs: number): void {
		this.insights.push({
			id: randomUUID(),
			sessionId: this.sessionId,
			type: "performance",
			timestamp: Date.now(),
			data: { operation, durationMs },
			summary: `${operation} took ${durationMs}ms`,
		})
	}

	getTopTools(limit = 5): Array<{ name: string; count: number }> {
		return [...this.toolUsageCounts.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, limit)
	}

	generateReport(): InsightsReport {
		return {
			sessionId: this.sessionId,
			startTime: this.startTime,
			endTime: Date.now(),
			totalTokens: this.totalTokens,
			totalCost: this.totalCost,
			toolUsageCount: [...this.toolUsageCounts.values()].reduce((a, b) => a + b, 0),
			errorCount: this.errorCount,
			topTools: this.getTopTools(),
			insights: [...this.insights],
		}
	}

	async persistReport(): Promise<string> {
		const report = this.generateReport()
		const fileName = `session-${this.sessionId}-${Date.now()}.json`
		const filePath = path.join(this.storagePath, fileName)
		await fs.writeFile(filePath, JSON.stringify(report, null, 2), "utf-8")
		return filePath
	}

	async getRecentReports(limit = 10): Promise<InsightsReport[]> {
		try {
			const files = await fs.readdir(this.storagePath)
			const jsonFiles = files
				.filter((f) => f.endsWith(".json"))
				.sort()
				.reverse()
				.slice(0, limit)

			const reports: InsightsReport[] = []
			for (const file of jsonFiles) {
				try {
					const content = await fs.readFile(path.join(this.storagePath, file), "utf-8")
					reports.push(JSON.parse(content))
				} catch {
					continue
				}
			}
			return reports
		} catch {
			return []
		}
	}

	getSessionId(): string {
		return this.sessionId
	}

	dispose(): void {
		this.insights = []
		this.toolUsageCounts.clear()
	}
}
