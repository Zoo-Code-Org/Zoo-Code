import { afterEach, expect, mock, test } from "bun:test"

type Event = {
	type: string
	properties: Record<string, any>
}

function feed<T>() {
	const list: T[] = []
	const wait: Array<() => void> = []
	const state = { done: false }

	return {
		push(item: T) {
			list.push(item)
			while (wait.length) wait.shift()?.()
		},
		end() {
			state.done = true
			while (wait.length) wait.shift()?.()
		},
		async *stream(onItem?: (item: T) => void) {
			while (!state.done || list.length) {
				if (list.length) {
					const item = list.shift() as T
					onItem?.(item)
					yield item
					continue
				}
				await new Promise<void>((resolve) => wait.push(resolve))
			}
		},
	}
}

function args() {
	return {
		_: [],
		$0: "zoo",
		message: ["hello", "zoo"],
		command: undefined,
		continue: false,
		session: undefined,
		fork: false,
		"cloud-fork": false,
		cloudFork: false,
		share: false,
		model: "test/test-model",
		agent: undefined,
		mode: undefined,
		format: "json",
		file: undefined,
		title: "smoke",
		attach: undefined,
		password: undefined,
		dir: undefined,
		port: undefined,
		variant: undefined,
		thinking: false,
		auto: false,
		"--": [],
	}
}

const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")

afterEach(() => {
	mock.restore()
	if (tty) {
		Object.defineProperty(process.stdin, "isTTY", tty)
		return
	}
	delete (process.stdin as { isTTY?: boolean }).isTTY
})

test("run uses local server path and sends a prompt through the SDK client", async () => {
	const q = feed<Event>()
	const consumed = Promise.withResolvers<void>()
	const prompts: any[] = []
	const clients: any[] = []

	mock.module("@kilocode/sdk/v2", () => ({
		createKiloClient: (options: any) => {
			clients.push(options)
			return {
				config: { get: async () => ({ data: { share: "manual" } }) },
				event: {
					subscribe: async () => ({
						stream: q.stream((event) => {
							if (event.type === "session.status") consumed.resolve()
						}),
					}),
				},
				permission: { reply: async () => ({ data: true }) },
				network: { reply: async () => ({ data: true }), reject: async () => ({ data: true }) },
				session: {
					create: async (input: any) => ({ data: { id: "ses_smoke", ...input } }),
					prompt: async (input: any) => {
						prompts.push(input)
						q.push({
							type: "message.part.updated",
							properties: {
								part: {
									id: "prt_text",
									type: "text",
									sessionID: "ses_smoke",
									text: "mocked provider reply",
									time: { end: Date.now() },
								},
							},
						})
						q.push({
							type: "session.status",
							properties: { sessionID: "ses_smoke", status: { type: "idle" } },
						})
						q.end()
						await consumed.promise
						return { data: undefined }
					},
				},
			}
		},
	}))

	Object.defineProperty(process.stdin, "isTTY", {
		configurable: true,
		value: true,
	})

	const key = JSON.stringify({ time: Date.now(), rand: Math.random() })
	const { RunCommand } = await import(`../../src/cli/cmd/run?${key}`)
	await RunCommand.handler(args() as never)

	expect(clients).toHaveLength(1)
	expect(clients[0].baseUrl).toBe("http://kilo.internal")
	expect(typeof clients[0].fetch).toBe("function")
	expect(prompts).toEqual([
		{
			sessionID: "ses_smoke",
			agent: undefined,
			model: { providerID: "test", modelID: "test-model" },
			variant: undefined,
			parts: [{ type: "text", text: "hello zoo" }],
		},
	])
})
