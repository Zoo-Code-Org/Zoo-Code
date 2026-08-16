import type { HistoryItem } from "@roo-code/types"

export type WorkerId = "A" | "B"

export type ParentToWorkerMessage =
	| {
			type: "initialize"
			workerId: WorkerId
			storageRoot: string
			pauseFirstLockCallback: boolean
	  }
	| { type: "stage"; requestId: string; item: HistoryItem }
	| { type: "flush"; requestId: string }
	| { type: "probe"; requestId: string }
	| { type: "release-lock"; requestId: string }
	| { type: "shutdown"; requestId: string }

interface WorkerEventBase {
	workerId: WorkerId
	pid: number
}

export type WorkerToParentMessage =
	| (WorkerEventBase & { type: "initialized"; cacheIds: string[] })
	| (WorkerEventBase & { type: "staged"; requestId: string; cacheIds: string[] })
	| (WorkerEventBase & { type: "flush-started"; requestId: string })
	| (WorkerEventBase & { type: "lock-attempted"; requestId: string })
	| (WorkerEventBase & { type: "lock-acquired"; requestId: string })
	| (WorkerEventBase & { type: "lock-paused"; requestId: string })
	| (WorkerEventBase & { type: "lock-callback-completed"; requestId: string })
	| (WorkerEventBase & { type: "flush-completed"; requestId: string })
	| (WorkerEventBase & {
			type: "probe-result"
			requestId: string
			flushPending: boolean
			insideLockCallback: boolean
	  })
	| (WorkerEventBase & { type: "lock-released-by-parent"; requestId: string })
	| (WorkerEventBase & { type: "shutdown-complete"; requestId: string })
	| (WorkerEventBase & { type: "worker-error"; requestType: string; message: string; stack?: string })
