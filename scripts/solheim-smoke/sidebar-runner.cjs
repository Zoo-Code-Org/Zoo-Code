"use strict"

// Runs inside the extension host through --extensionTestsPath so the smoke
// recording shows the Zoo Code chat panel. VS Code exits once the run()
// export settles, so run() must never settle: it focuses the sidebar, waits
// for the webview, then stays pending until the driver tears the host down.
// The IPC start path keeps focusSidebar: false; this module owns focus instead.

const vscode = require("vscode")
const fs = require("node:fs/promises")

const EXTENSION_ID = "ZooCodeOrganization.zoo-code"
const FOCUS_COMMAND = "zoo-code.SidebarProvider.focus"
const POLL_INTERVAL_MS = 100
const READY_TIMEOUT_MS = 120_000

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function focusSidebarWhenReady() {
	const extension = vscode.extensions.getExtension(EXTENSION_ID)
	if (!extension) throw new Error("Zoo Code extension not found")
	const api = extension.isActive ? extension.exports : await extension.activate()
	await vscode.commands.executeCommand(FOCUS_COMMAND)
	const deadline = Date.now() + READY_TIMEOUT_MS
	while (!api.isReady()) {
		if (Date.now() >= deadline) throw new Error("Zoo Code webview did not launch in time")
		await delay(POLL_INTERVAL_MS)
	}
}

async function writeStatus(status) {
	const target = process.env.AGENT_EVALS_TESTS_DIAGNOSTICS_PATH
	if (!target) return
	// Fixed metadata only: extension errors can contain private host details.
	await fs.writeFile(target, JSON.stringify({ status }))
}

exports.run = async () => {
	try {
		await focusSidebarWhenReady()
		await writeStatus("ready")
	} catch {
		// Focus is best effort for the recording. A rejected run() would end
		// the test host and cut the smoke short. Persist bounded evidence instead.
		await writeStatus("failed").catch(() => {})
	}
	await new Promise(() => {})
}
