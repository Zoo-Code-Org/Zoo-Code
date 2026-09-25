/**
 * Shared constants for the browser bridge, used by both the server side
 * (`src/core/webview/browserBridge.ts`) and the webview client
 * (`webview-ui/src/utils/browserBridgeClient.ts`).
 */

/**
 * The message of the error with which the bridge server's handshake
 * middleware rejects unauthenticated sockets. The client matches on it to
 * tell a non-retryable rejection (wrong/expired bridge token) apart from
 * transient connection failures, so the two sides must share this exact
 * string.
 */
export const BROWSER_BRIDGE_UNAUTHORIZED_MESSAGE = "unauthorized"
