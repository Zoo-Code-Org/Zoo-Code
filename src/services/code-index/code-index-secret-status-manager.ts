import type * as vscode from "vscode"
import type { ClineProvider } from "../../core/webview/ClineProvider"

/** Reports secret presence without exposing values or requiring an open workspace. */
export class CodeIndexSecretStatusManager {
	public constructor(private readonly secrets: vscode.SecretStorage) {}

	public async postStatus(provider: Pick<ClineProvider, "postMessageToWebview">): Promise<void> {
		// Read VS Code secret storage directly for current, asynchronous values.
		const hasOpenAiKey = !!(await this.secrets.get("codeIndexOpenAiKey"))
		const hasQdrantApiKey = !!(await this.secrets.get("codeIndexQdrantApiKey"))
		const hasOpenAiCompatibleApiKey = !!(await this.secrets.get("codebaseIndexOpenAiCompatibleApiKey"))
		const hasGeminiApiKey = !!(await this.secrets.get("codebaseIndexGeminiApiKey"))
		const hasMistralApiKey = !!(await this.secrets.get("codebaseIndexMistralApiKey"))
		const hasVercelAiGatewayApiKey = !!(await this.secrets.get("codebaseIndexVercelAiGatewayApiKey"))
		const hasOpenRouterApiKey = !!(await this.secrets.get("codebaseIndexOpenRouterApiKey"))

		await provider.postMessageToWebview({
			type: "codeIndexSecretStatus",
			values: {
				hasOpenAiKey,
				hasQdrantApiKey,
				hasOpenAiCompatibleApiKey,
				hasGeminiApiKey,
				hasMistralApiKey,
				hasVercelAiGatewayApiKey,
				hasOpenRouterApiKey,
			},
		})
	}
}
