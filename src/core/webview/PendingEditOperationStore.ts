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
export type PendingEditOperationView = Omit<PendingEditOperation, "timeoutId" | "createdAt">

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
			this.log(`[PendingEditOperationStore.set] Automatically cleared stale pending operation: ${operationId}`)
		}, this.timeoutMs)

		this.operations.set(operationId, {
			...editData,
			images: editData.images ? [...editData.images] : undefined,
			timeoutId,
			createdAt: Date.now(),
		})

		this.log(`[PendingEditOperationStore.set] Set pending operation: ${operationId}`)
	}

	get(operationId: string): PendingEditOperationView | undefined {
		const operation = this.operations.get(operationId)
		if (!operation) {
			return undefined
		}

		return {
			messageTs: operation.messageTs,
			editedContent: operation.editedContent,
			images: operation.images ? [...operation.images] : undefined,
			messageIndex: operation.messageIndex,
			apiConversationHistoryIndex: operation.apiConversationHistoryIndex,
		}
	}

	clear(operationId: string): boolean {
		const operation = this.operations.get(operationId)
		if (!operation) {
			return false
		}

		clearTimeout(operation.timeoutId)
		this.operations.delete(operationId)
		this.log(`[PendingEditOperationStore.clear] Cleared pending operation: ${operationId}`)
		return true
	}

	clearAll(): void {
		for (const operation of this.operations.values()) {
			clearTimeout(operation.timeoutId)
		}

		this.operations.clear()
		this.log("[PendingEditOperationStore.clearAll] Cleared all pending operations")
	}
}
