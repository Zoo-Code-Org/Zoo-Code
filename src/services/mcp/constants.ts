export const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000 // 5 minutes
export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
// Bounds for automatic reconnects that reuse a saved token the server rejected.
// Each retry delays before reconnecting; at the limit the flow ends with a
// visible error instead of retrying the same rejected token again.
export const OAUTH_TOKEN_RETRY_MAX_ATTEMPTS = 3
export const OAUTH_TOKEN_RETRY_BASE_DELAY_MS = 1000
export const OAUTH_TOKEN_RETRY_MAX_DELAY_MS = 10_000
