import type { FileResult, ReadFileContext } from "../types"

export abstract class ReadFileStrategy {
	abstract canRead(context: ReadFileContext): boolean
	abstract read(context: ReadFileContext): Promise<FileResult>
}
