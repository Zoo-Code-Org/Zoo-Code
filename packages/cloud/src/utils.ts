import type { ExtensionContext } from "vscode"

export function getUserAgent(context?: ExtensionContext): string {
	return `Zoo-Code ${context?.extension?.packageJSON?.version || "unknown"}`
}
