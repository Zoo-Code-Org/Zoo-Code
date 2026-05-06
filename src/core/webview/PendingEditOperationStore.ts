export interface PendingEditOperation {
	messageTs: number
	editedContent: string
	images?: string[]
	messageIndex: number
	apiConversationHistoryIndex: number
	timeoutId: NodeJS.Timeout
	createdAt: number
}

export type PendingEditOperationInput = Omit<PendingEditOperation, "timeoutId" | "createdAt">

export class PendingEditOperationStore {
	private readonly operations = new Map<string, PendingEditOperation>()

	constructor(
		private readonly timeoutMs: number,
		private readonly log: (message: string) => void,
	) {}

	set(operationId: string, editData: PendingEditOperationInput): void {
		this.clear(operationId)

		const timeoutId = setTimeout(() => {
			this.clear(operationId)
			this.log(`[setPendingEditOperation] Automatically cleared stale pending operation: ${operationId}`)
		}, this.timeoutMs)

		this.operations.set(operationId, {
			...editData,
			timeoutId,
			createdAt: Date.now(),
		})

		this.log(`[setPendingEditOperation] Set pending operation: ${operationId}`)
	}

	get(operationId: string): PendingEditOperation | undefined {
		return this.operations.get(operationId)
	}

	clear(operationId: string): boolean {
		const operation = this.operations.get(operationId)
		if (!operation) {
			return false
		}

		clearTimeout(operation.timeoutId)
		this.operations.delete(operationId)
		this.log(`[clearPendingEditOperation] Cleared pending operation: ${operationId}`)
		return true
	}

	clearAll(): void {
		for (const operation of this.operations.values()) {
			clearTimeout(operation.timeoutId)
		}

		this.operations.clear()
		this.log("[clearAllPendingEditOperations] Cleared all pending operations")
	}
}
