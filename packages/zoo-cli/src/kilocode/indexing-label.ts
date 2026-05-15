import type { KiloIndexing } from "./indexing"

export function formatIndexingLabel(status: KiloIndexing.Status): string {
	if (status.state === "In Progress") {
		if (status.totalFiles <= 0) return "IDX In Progress"
		return `IDX ${status.percent}% ${status.processedFiles}/${status.totalFiles}`
	}

	if (status.state === "Error") {
		return `IDX ${status.message}`
	}

	if (status.state === "Standby") {
		return "IDX Standby"
	}

	return `IDX ${status.state}`
}
