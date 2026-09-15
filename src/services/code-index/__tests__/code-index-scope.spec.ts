import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"

import { CodeIndexController } from "../code-index-controller"
import { CodeIndexManager } from "../manager"
import { CodeIndexScope } from "../code-index-scope"
import { CodeIndexStateManager } from "../state-manager"

vi.mock("vscode", () => ({
	EventEmitter: class {
		public readonly event = vi.fn().mockReturnValue({ dispose: vi.fn() })
		public fire = vi.fn()
		public dispose = vi.fn()
	},
}))

vi.mock("../manager", () => ({
	CodeIndexManager: vi.fn().mockImplementation(function () {
		return { dispose: vi.fn() }
	}),
}))

describe("CodeIndexScope", () => {
	it("owns one code index manager for the workspace lifetime", () => {
		const workspacePath = "/workspace"
		const folderUri = makeUri(workspacePath)
		const context = makeExtensionContext()

		const codeIndexScope = new CodeIndexScope(workspacePath, folderUri, context)

		expect(codeIndexScope.codeIndexStateManager).toBeInstanceOf(CodeIndexStateManager)
		expect(CodeIndexManager).toHaveBeenCalledExactlyOnceWith(
			workspacePath,
			folderUri,
			context,
			codeIndexScope.codeIndexStateManager,
		)
		expect(codeIndexScope.codeIndexManager).toBeInstanceOf(Object)
		expect(codeIndexScope.codeIndexController).toBeInstanceOf(CodeIndexController)
		expect(codeIndexScope.codeIndexController["codeIndexManager"]).toBe(codeIndexScope.codeIndexManager)
		expect(codeIndexScope.codeIndexController["codeIndexStateManager"]).toBe(codeIndexScope.codeIndexStateManager)
		const controllerDispose = vi.spyOn(codeIndexScope.codeIndexController, "dispose")

		codeIndexScope.dispose()

		expect(controllerDispose).toHaveBeenCalledTimes(1)
		expect(codeIndexScope.codeIndexManager.dispose).toHaveBeenCalledTimes(1)
	})
})
