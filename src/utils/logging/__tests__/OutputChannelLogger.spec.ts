import { OutputChannelLogger, type LogOutputChannel } from "../index"

function createChannel() {
	const lines: string[] = []
	const channel: LogOutputChannel = { appendLine: (value) => lines.push(value) }
	return { channel, lines }
}

describe("OutputChannelLogger", () => {
	it("writes the level and the message", () => {
		const { channel, lines } = createChannel()

		new OutputChannelLogger(channel).info("stream ended")

		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain("INFO stream ended")
	})

	it("renders ctx as a prefix and other meta as indented pairs", () => {
		const { channel, lines } = createChannel()

		new OutputChannelLogger(channel).warn("unmodelled event", { ctx: "bedrock", eventName: "someFutureEvent" })

		expect(lines[0]).toContain("WARN (bedrock) unmodelled event")
		expect(lines[0]).toContain("\n  eventName: someFutureEvent")
	})

	it("keeps the stack of an Error message", () => {
		const { channel, lines } = createChannel()
		const error = new Error("validationException: duplicate Ids")

		new OutputChannelLogger(channel).error(error)

		expect(lines[0]).toContain("validationException: duplicate Ids")
		expect(lines[0]).toContain(error.stack!)
	})

	it("serializes object meta and survives a circular one", () => {
		const { channel, lines } = createChannel()
		const circular: Record<string, unknown> = {}
		circular.self = circular

		const logger = new OutputChannelLogger(channel)
		logger.debug("plain", { payload: { a: 1 } })
		logger.debug("circular", { payload: circular })

		expect(lines[0]).toContain('\n  payload: {"a":1}')
		expect(lines[1]).toContain("\n  payload: [non-serializable]")
	})

	it("omits undefined meta values", () => {
		const { channel, lines } = createChannel()

		new OutputChannelLogger(channel).info("partial", { present: "yes", absent: undefined })

		expect(lines[0]).toContain("present: yes")
		expect(lines[0]).not.toContain("absent")
	})

	it("merges parent meta into a child logger", () => {
		const { channel, lines } = createChannel()

		new OutputChannelLogger(channel, { ctx: "task" }).child({ taskId: "abc" }).error("failed")

		expect(lines[0]).toContain("ERROR (task) failed")
		expect(lines[0]).toContain("taskId: abc")
	})
})
