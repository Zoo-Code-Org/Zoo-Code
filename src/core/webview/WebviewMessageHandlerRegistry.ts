import type { WebviewMessage } from "@roo-code/types"

export interface WebviewMessageFeatureHandler {
	canHandle(message: WebviewMessage): boolean
	handle(message: WebviewMessage): Promise<void>
}

export class WebviewMessageHandlerRegistry {
	public constructor(private readonly webviewMessageFeatureHandlers: readonly WebviewMessageFeatureHandler[]) {}

	public async handle(message: WebviewMessage): Promise<boolean> {
		const webviewMessageFeatureHandler = this.webviewMessageFeatureHandlers.find((candidate) =>
			candidate.canHandle(message),
		)
		if (!webviewMessageFeatureHandler) return false

		await webviewMessageFeatureHandler.handle(message)
		return true
	}
}
