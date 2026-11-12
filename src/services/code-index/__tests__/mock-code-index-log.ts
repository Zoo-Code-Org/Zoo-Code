vi.mock("../code-index-log", () => ({
	codeIndexLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
// Embedder failure paths report telemetry; an uninitialized singleton would turn a 429 into a permanent error.
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureEvent: vi.fn() } },
}))
