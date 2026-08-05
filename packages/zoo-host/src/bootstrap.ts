import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

import type { RooCodeAPI } from "@roo-code/types"
import { createVSCodeAPI, type SecretStorage } from "@roo-code/vscode-shim"

import { validateHostRoots, type HostRoots } from "./roots.js"

type ExtensionModule = { activate(context: unknown): Promise<RooCodeAPI>; deactivate?(): Promise<void> }

export async function activateExtensionHost(rootsInput: HostRoots, secretStorage: SecretStorage) {
	const roots = validateHostRoots(rootsInput)
	const bundlePath = path.join(roots.extensionRoot, "extension.js")
	if (!fs.existsSync(bundlePath)) throw new Error(`Extension bundle not found at ${bundlePath}`)
	const vscode = createVSCodeAPI(roots.extensionRoot, roots.workspaceRoot, undefined, {
		appRoot: roots.appRoot,
		storageDir: roots.storageRoot,
		secretStorage,
	})
	;(globalThis as Record<string, unknown>).vscode = vscode
	const require = createRequire(import.meta.url)
	const Module = require("module") as {
		_resolveFilename(request: string, parent: unknown, isMain: boolean, options: unknown): string
	}
	const originalResolve = Module._resolveFilename
	Module._resolveFilename = function (request, parent, isMain, options) {
		return request === "vscode" ? "zoo-vscode-shim" : originalResolve.call(this, request, parent, isMain, options)
	}
	require.cache["zoo-vscode-shim"] = {
		id: "zoo-vscode-shim",
		filename: "zoo-vscode-shim",
		loaded: true,
		exports: vscode,
		children: [],
		paths: [],
		path: "",
		isPreloading: false,
		parent: null,
		require,
	} as unknown as NodeJS.Module
	let extension: ExtensionModule
	try {
		extension = require(bundlePath) as ExtensionModule
	} finally {
		Module._resolveFilename = originalResolve
	}
	const api = await extension.activate(vscode.context)
	await api.initializeHeadless()
	return {
		api,
		async dispose() {
			await api.shutdownHeadless()
			await extension.deactivate?.()
			vscode.context.dispose()
			delete (globalThis as Record<string, unknown>).vscode
		},
	}
}
