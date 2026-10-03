describe("shared/browserBridge", () => {
	describe("BROWSER_BRIDGE_UNAUTHORIZED_MESSAGE", () => {
		it("pins the wire string the bridge handshake and the webview client both match on", async () => {
			const { BROWSER_BRIDGE_UNAUTHORIZED_MESSAGE } = await import("../browserBridge")

			// The server's handshake middleware rejects unauthenticated sockets
			// with this exact error message, and the webview client's retry
			// classifier matches on it to tell a non-retryable token rejection
			// apart from transient connection failures. Renaming the value on
			// either side silently breaks that classification, so the literal is
			// asserted here — against the shared module itself — not only
			// through the server-side consumers.
			expect(BROWSER_BRIDGE_UNAUTHORIZED_MESSAGE).toBe("unauthorized")
		})
	})
})
