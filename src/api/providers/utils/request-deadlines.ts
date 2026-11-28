import { Agent } from "undici"

import { isProxyEnabled } from "../../../utils/networkProxy"

/**
 * The undici dispatcher whose idle deadlines follow the request budget.
 *
 * Node's fetch keeps hidden 300 s `headersTimeout`/`bodyTimeout` defaults,
 * so a request that waits longer than 300 s for response headers or body
 * data dies with "TypeError: terminated" even when the SDK `timeout` is
 * larger (#1407). The dispatcher moves both transport deadlines onto the
 * request budget.
 *
 * Returns `undefined` while the debug proxy is active: the proxy routes
 * requests through a global proxy dispatcher, and an explicit dispatcher
 * on the request would bypass it.
 */
export function createIdleDeadlineDispatcher(budgetMs: number): Agent | undefined {
	if (isProxyEnabled() || !Number.isFinite(budgetMs) || budgetMs <= 0) {
		return undefined
	}

	return new Agent({ headersTimeout: budgetMs, bodyTimeout: budgetMs })
}

/**
 * The OpenAI client `fetchOptions` that carry the deadline dispatcher.
 *
 * Returns an empty object when no dispatcher may be wired (debug proxy
 * active, or a non-positive or non-finite budget), so call sites spread it
 * unconditionally.
 */
export function createRequestDeadlineFetchOptions(
	budgetMs: number,
): { fetchOptions: { dispatcher: Agent } } | Record<string, never> {
	const dispatcher = createIdleDeadlineDispatcher(budgetMs)

	return dispatcher ? { fetchOptions: { dispatcher } } : {}
}
