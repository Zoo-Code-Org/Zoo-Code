import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import type { Config } from "@/config/config"
import { Schema } from "effect"

export namespace KiloIndexing {
	export type StatusState = "Disabled" | "Standby" | "In Progress" | "Complete" | "Error"

	export type SearchMatch = {
		score: number
		payload?: {
			filePath?: string
			codeChunk?: string
			startLine?: number
			endLine?: number
		}
	}

	export type Status = {
		state: StatusState
		message: string
		processedFiles: number
		totalFiles: number
		percent: number
	}

	const StatusSchema = Schema.Struct({
		state: Schema.Literals(["Disabled", "Standby", "In Progress", "Complete", "Error"]),
		message: Schema.String,
		processedFiles: Schema.Number,
		totalFiles: Schema.Number,
		percent: Schema.Number,
	}).annotate({ identifier: "IndexingStatus" })

	export const Event = BusEvent.define(
		"indexing.status",
		Schema.Struct({
			status: StatusSchema,
		}),
	)

	const disabled: Status = {
		state: "Disabled",
		message: "Codebase indexing is not bundled in Zoo Code CLI.",
		processedFiles: 0,
		totalFiles: 0,
		percent: 0,
	}

	export async function init() {
		await Bus.publish(Event, { status: disabled })
	}

	export async function current(): Promise<Status> {
		return disabled
	}

	export function ready(): boolean {
		return false
	}

	export async function available(): Promise<boolean> {
		return false
	}

	export async function search(_query?: string, _path?: string): Promise<SearchMatch[]> {
		return []
	}

	export function input(project?: Config.Indexing, global?: Config.Indexing): Config.Indexing {
		return {
			...global,
			...project,
			enabled: project?.enabled === true || global?.enabled === true,
		}
	}
}
