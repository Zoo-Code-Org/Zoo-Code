import * as fs from "fs"
import * as path from "path"

/**
 * The spelling an artefact should be named by when one file is spelled more than one way. An 8.3
 * alias, a case variant on a case-insensitive volume, and the long form all name one directory
 * entry, and only one of those spellings can be the name of the artefact if two writers are to
 * contend at all. The native realpath is the call that answers this: it reports the spelling the
 * volume itself holds, which plain `fs.realpathSync` does not - on a Windows volume with 8.3
 * generation on, `fs.realpathSync` hands an alias straight back, so it converges nothing, while
 * the native call returns the long form for both the alias and a case variant of it. Only the
 * final component is re-spelled, never the directory: `fileLock` deliberately passes
 * `realpath: false` to the lock library because the file may not exist yet, and the artefact has
 * to stay beside the file the caller named. Where the volume has no spelling to report - the leaf
 * is not created yet, or it is a link whose target is gone - the call throws and the caller's own
 * spelling is returned unchanged, which is the behaviour today.
 */
export function canonicalLeafSpelling(absolutePath: string): string {
	try {
		const volumeSpelling = path.basename(fs.realpathSync.native(absolutePath))
		return volumeSpelling === path.basename(absolutePath)
			? absolutePath
			: path.join(path.dirname(absolutePath), volumeSpelling)
	} catch {
		// Nothing to converge: a leaf that does not exist yet has no volume spelling, and a dangling
		// link has no target to name. Refusing the write for either would be worse than today.
		return absolutePath
	}
}
