import type { ReadFileParams } from "@roo-code/types"
import { getReadFileBatchEnvelopeBytes } from "./readFileBatchBudget"
import { formatReadFileBatchEntry, type BatchFileResult } from "./readFileBatchEntry"

/** File-reading output: reserve metadata, share content budget, and accumulate sections. */
export class ReadFileBatchOutput {
	private remainingContentBytes: number
	private readonly sections: string[] = []

	constructor(
		readonly budget: number,
		readonly count: number,
	) {
		this.remainingContentBytes = Math.max(0, budget - getReadFileBatchEnvelopeBytes(count))
	}

	get contentAllowance(): number {
		// Sharing unused allowance prevents a large first entry starving later files.
		const remainingEntries = this.count - this.sections.length
		return remainingEntries > 0 ? Math.floor(this.remainingContentBytes / remainingEntries) : 0
	}

	add(entry: ReadFileParams, result: BatchFileResult): void {
		const rendered = formatReadFileBatchEntry(entry, result, this.sections.length + 1, this.contentAllowance)
		this.remainingContentBytes -= rendered.contentBytes
		this.sections.push(rendered.section)
	}

	toString(): string {
		const header = `Batch read: ${this.count} entries; result budget ${this.budget} bytes.\n`
		const notice =
			this.budget < getReadFileBatchEnvelopeBytes(this.count)
				? "Insufficient context for file content; only the bounded status manifest is returned. Free context before retrying.\n"
				: ""
		return header + notice + this.sections.join("\n\n---\n\n")
	}
}
