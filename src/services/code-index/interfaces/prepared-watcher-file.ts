import type { FileProcessingResult, PointStruct } from "../interfaces"

export type PreparedWatcherFile =
	| { kind: "completed"; result: FileProcessingResult }
	| { kind: "upsert"; points: PointStruct[]; file?: { path: string; newHash?: string } }
