vi.mock("../code-index-log", () => ({
	codeIndexLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
