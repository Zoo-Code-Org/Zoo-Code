import path from "node:path"

export type HostRoots = {
	extensionRoot: string
	workspaceRoot: string
	storageRoot: string
	appRoot: string
}

export function validateHostRoots(roots: HostRoots): HostRoots {
	for (const [name, value] of Object.entries(roots)) {
		if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
	}
	return {
		extensionRoot: path.resolve(roots.extensionRoot),
		workspaceRoot: path.resolve(roots.workspaceRoot),
		storageRoot: path.resolve(roots.storageRoot),
		appRoot: path.resolve(roots.appRoot),
	}
}
