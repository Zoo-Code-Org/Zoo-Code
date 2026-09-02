import type { Page } from "@playwright/test"

import type { WebviewMessage } from "@roo/WebviewMessage"

declare global {
	interface Window {
		__vscodeMessages: WebviewMessage[]
	}
}

export function getCapturedVscodeMessages(page: Page): Promise<WebviewMessage[]> {
	return page.evaluate(() => window.__vscodeMessages)
}
