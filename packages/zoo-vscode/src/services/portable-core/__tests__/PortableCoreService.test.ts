const { createZooServer } = vitest.hoisted(() => ({
	createZooServer: vitest.fn(),
}))

const { usePortableCore } = vitest.hoisted(() => ({
	usePortableCore: vitest.fn(),
}))

vitest.mock("@zoo-code/sdk", () => ({
	createZooServer,
}))

vitest.mock("../../../utils/config", () => ({
	usePortableCore,
}))

import { PortableCoreService } from "../PortableCoreService"

describe("PortableCoreService", () => {
	const createOutputChannel = () => ({
		appendLine: vitest.fn(),
	})

	const createContext = () => ({
		subscriptions: [],
		extensionPath: "/extension",
	})

	beforeEach(() => {
		vitest.clearAllMocks()
	})

	it("does not start the SDK when portable core is disabled", async () => {
		usePortableCore.mockReturnValue(false)

		const service = await PortableCoreService.create(createContext() as any, createOutputChannel() as any)

		expect(service).toBeUndefined()
		expect(createZooServer).not.toHaveBeenCalled()
	})

	it("starts and connects to the SDK when portable core is enabled", async () => {
		usePortableCore.mockReturnValue(true)
		const client = { close: vitest.fn().mockResolvedValue(undefined) }
		const handle = {
			ipcPath: "/tmp/zoo-test.sock",
			reused: false,
			connect: vitest.fn().mockResolvedValue(client),
			close: vitest.fn().mockResolvedValue(undefined),
		}
		createZooServer.mockResolvedValue(handle)
		const outputChannel = createOutputChannel()

		const service = await PortableCoreService.create(createContext() as any, outputChannel as any)

		expect(createZooServer).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
		expect(handle.connect).toHaveBeenCalledTimes(1)
		expect(service?.client).toBe(client)
		expect(service?.ipcPath).toBe("/tmp/zoo-test.sock")
		expect(service?.reused).toBe(false)
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"[PortableCore] Started Zoo CLI server at /tmp/zoo-test.sock",
		)
	})

	it("logs when reusing an existing SDK server", async () => {
		usePortableCore.mockReturnValue(true)
		const handle = {
			ipcPath: "/tmp/zoo-existing.sock",
			reused: true,
			connect: vitest.fn().mockResolvedValue({ close: vitest.fn().mockResolvedValue(undefined) }),
			close: vitest.fn().mockResolvedValue(undefined),
		}
		createZooServer.mockResolvedValue(handle)
		const outputChannel = createOutputChannel()

		await PortableCoreService.create(createContext() as any, outputChannel as any)

		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"[PortableCore] Reused Zoo CLI server at /tmp/zoo-existing.sock",
		)
	})

	it("creates a session adapter wired to the connected client", async () => {
		usePortableCore.mockReturnValue(true)
		const client = {
			createSession: vitest.fn().mockResolvedValue({ id: "session-1" }),
			listSessions: vitest.fn().mockResolvedValue([]),
			getSession: vitest.fn().mockResolvedValue({ id: "session-1" }),
			close: vitest.fn().mockResolvedValue(undefined),
		}
		const handle = {
			ipcPath: "/tmp/zoo-test.sock",
			reused: false,
			connect: vitest.fn().mockResolvedValue(client),
			close: vitest.fn().mockResolvedValue(undefined),
		}
		createZooServer.mockResolvedValue(handle)

		const service = await PortableCoreService.create(createContext() as any, createOutputChannel() as any)
		const adapter = service!.createSessionAdapter()

		await adapter.createSession({ title: "Adapter smoke" })
		expect(client.createSession).toHaveBeenCalledWith({ title: "Adapter smoke" })
	})

	it("continues with the legacy runtime when SDK startup fails", async () => {
		usePortableCore.mockReturnValue(true)
		createZooServer.mockRejectedValue(new Error("missing zoo binary"))
		const outputChannel = createOutputChannel()

		const service = await PortableCoreService.create(createContext() as any, outputChannel as any)

		expect(service).toBeUndefined()
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"[PortableCore] Initialization failed; continuing with legacy extension-host runtime: missing zoo binary",
		)
	})

	it("disposes client and server once", async () => {
		usePortableCore.mockReturnValue(true)
		const client = { close: vitest.fn().mockResolvedValue(undefined) }
		const handle = {
			ipcPath: "/tmp/zoo-test.sock",
			reused: false,
			connect: vitest.fn().mockResolvedValue(client),
			close: vitest.fn().mockResolvedValue(undefined),
		}
		createZooServer.mockResolvedValue(handle)

		const service = await PortableCoreService.create(createContext() as any, createOutputChannel() as any)
		await service?.dispose()
		await service?.dispose()

		expect(client.close).toHaveBeenCalledTimes(1)
		expect(handle.close).toHaveBeenCalledTimes(1)
	})
})
