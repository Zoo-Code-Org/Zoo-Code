import { vi } from "vitest"
import type * as vscode from "vscode"

import { ClineProviderFactory } from "../core/webview/ClineProviderFactory"
import { WebviewFocusTracker } from "../core/webview/WebviewFocusTracker"
import { makeExtensionContext } from "./vscode"

export function makeClineProviderFactory(): ClineProviderFactory {
	const outputChannel: vscode.OutputChannel = {
		name: "test-output",
		append: vi.fn(),
		appendLine: vi.fn(),
		replace: vi.fn(),
		clear: vi.fn(),
		show: vi.fn(),
		hide: vi.fn(),
		dispose: vi.fn(),
	}
	const factory = new ClineProviderFactory(makeExtensionContext(), outputChannel, new WebviewFocusTracker())
	factory.createInNewTab = vi
		.fn<ClineProviderFactory["createInNewTab"]>()
		.mockRejectedValue(new Error("Unexpected editor-tab creation in this test"))
	return factory
}
