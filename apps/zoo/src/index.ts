import { Command, Option } from "commander"

import { listSessions, runAutomation } from "./automation.js"
import { parseDuration, resolveWorkspace, type OutputFormat, type SharedOptions } from "./options.js"

const program = new Command().name("zoo").description("Run Zoo Code from the terminal").version("0.1.0")

async function readPipedStdin(): Promise<string> {
	if (process.stdin.isTTY) return ""
	let input = ""
	process.stdin.setEncoding("utf8")
	for await (const chunk of process.stdin) input += chunk
	return input.trim()
}

function shared(command: Command): Command {
	return command
		.option("-C, --cwd <path>", "effective workspace", process.cwd())
		.option("--provider <id>", "ephemeral provider selection")
		.option("--profile <name>", "ephemeral provider profile")
		.option("--model <id>", "ephemeral model selection")
		.option("--mode <slug>", "ephemeral mode selection")
		.addOption(
			new Option("--reasoning-effort <level>").choices([
				"disabled",
				"none",
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]),
		)
		.addOption(new Option("--approval <mode>").choices(["interactive", "safe", "auto"]))
		.option("--ephemeral", "remove invocation state after cleanup")
		.option("--timeout <duration>", "whole-task deadline")
		.option("--debug", "write redacted diagnostics to stderr")
}

function automation(command: Command): Command {
	return shared(command)
		.addOption(new Option("--format <format>").choices(["text", "json", "stream-json"]).default("text"))
		.option("--quiet", "print only the final answer or result")
}

function normalized(options: SharedOptions & { format: OutputFormat; quiet: boolean }) {
	return { ...options, workspace: resolveWorkspace(options.cwd), timeout: parseDuration(options.timeout) }
}

program.argument("[prompt...]")

automation(program.command("run [prompt...]").description("run one task without an interactive UI")).action(
	async (words: string[] | undefined, options: SharedOptions & { format: OutputFormat; quiet: boolean }) => {
		const positional = words?.join(" ").trim()
		const piped = await readPipedStdin()
		if (positional && piped) throw new Error("Use either a positional prompt or piped stdin, not both")
		const prompt = positional || piped
		if (!prompt) throw new Error("zoo run requires a prompt or piped stdin")
		process.exitCode = await runAutomation({ type: "run", prompt }, normalized(options))
	},
)

automation(program.command("resume [task-id]").description("resume a workspace session")).action(
	async (taskId: string | undefined, options: SharedOptions & { format: OutputFormat; quiet: boolean }) => {
		process.exitCode = await runAutomation({ type: "resume", taskId }, normalized(options))
	},
)

const sessions = program.command("sessions").description("inspect canonical sessions")
shared(
	sessions.command("list").addOption(new Option("--format <format>").choices(["text", "json"]).default("text")),
).action(async (options: SharedOptions & { format: "text" | "json" }) => {
	await listSessions({ ...options, workspace: resolveWorkspace(options.cwd) })
})

program.action(async (words: string[] | undefined, options: SharedOptions) => {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive Zoo requires TTY stdin and stdout")
	const { runInteractive } = await import("./interactive.js")
	process.exitCode = await runInteractive(words?.join(" ").trim(), {
		...options,
		workspace: resolveWorkspace(options.cwd ?? process.cwd()),
	})
})

program.showSuggestionAfterError().showHelpAfterError()
await program.parseAsync().catch((error) => {
	const message = error instanceof Error ? error.message : String(error)
	process.stderr.write(`zoo: ${message}\n`)
	process.exitCode = message.includes("SIGINT") ? 130 : message.includes("SIGTERM") ? 143 : 2
})
