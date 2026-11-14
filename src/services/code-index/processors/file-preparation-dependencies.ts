import type { Ignore } from "ignore"
import type { FileSystem } from "vscode"
import type { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import type { CacheManager } from "../cache-manager"
import type { ICodeParser } from "../interfaces"

export interface FilePreparationDependencies {
	workspacePath: string
	ignoreController: Pick<RooIgnoreController, "validateAccess">
	ignoreInstance?: Pick<Ignore, "ignores">
	fileSystem: Pick<FileSystem, "stat" | "readFile">
	cacheManager: Pick<CacheManager, "getHash">
	parser: ICodeParser
}
