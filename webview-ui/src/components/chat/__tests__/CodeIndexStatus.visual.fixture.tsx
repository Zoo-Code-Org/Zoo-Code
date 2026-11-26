import { useEffect } from "react"

import type { IndexingStatus } from "@roo-code/types"

import { IndexingStatusBadge } from "../IndexingStatusBadge"

const failedFile = {
	path: "src/broken.ts",
	activity: "embed",
	reason: "Server error after 3 attempts",
	state: "exhausted",
} as const

export const codeIndexStatusFixtures: Record<string, IndexingStatus> = {
	"failed-files": {
		systemStatus: "Standby",
		processedItems: 41,
		totalItems: 42,
		currentItemUnit: "blocks",
		failedFiles: [failedFile],
		failedFileSummary: { ...failedFile, count: 1 },
	},
	"provider-wait": {
		systemStatus: "Indexing",
		processedItems: 10,
		totalItems: 42,
		currentItemUnit: "blocks",
		providerWaits: [{ service: "OpenAI", waitingFiles: ["src/a.ts", "src/b.ts"] }],
	},
	"amber-badge": {
		systemStatus: "Indexed",
		processedItems: 42,
		totalItems: 42,
		currentItemUnit: "blocks",
		failedFiles: [failedFile],
	},
}

function StatusFeeder({ status }: { status: IndexingStatus }) {
	useEffect(() => {
		window.postMessage({ type: "indexingStatusUpdate", values: status }, "*")
	}, [status])
	return null
}

export function CodeIndexStatusFixture({ variant }: { variant: string }) {
	return (
		<div className="p-4">
			<IndexingStatusBadge />
			<StatusFeeder status={codeIndexStatusFixtures[variant]} />
		</div>
	)
}
