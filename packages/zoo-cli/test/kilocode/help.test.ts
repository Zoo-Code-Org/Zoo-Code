import { describe, test, expect } from "bun:test"
import path from "path"
import { generateHelp, generateCommandTable } from "../../src/kilocode/help"
import { AcpCommand } from "../../src/cli/cmd/acp"
import { McpCommand } from "../../src/cli/cmd/mcp"
import { RunCommand } from "../../src/cli/cmd/run"
import { GenerateCommand } from "../../src/cli/cmd/generate"
import { DebugCommand } from "../../src/cli/cmd/debug"
import { ProvidersCommand } from "../../src/cli/cmd/providers" // kilocode_change — upstream renamed auth → providers
import { AgentCommand } from "../../src/cli/cmd/agent"
import { UpgradeCommand } from "../../src/cli/cmd/upgrade"
import { UninstallCommand } from "../../src/cli/cmd/uninstall"
import { ServeCommand } from "../../src/cli/cmd/serve"
import { WebCommand } from "../../src/cli/cmd/web"
import { ModelsCommand } from "../../src/cli/cmd/models"
import { StatsCommand } from "../../src/cli/cmd/stats"
import { ExportCommand } from "../../src/cli/cmd/export"
import { ImportCommand } from "../../src/cli/cmd/import"
import { PrCommand } from "../../src/cli/cmd/pr"
import { SessionCommand } from "../../src/cli/cmd/session"
import { RemoteCommand } from "../../src/cli/cmd/remote"
import { ConfigCommand as ConfigCLICommand } from "../../src/cli/cmd/config"
import { PluginCommand } from "../../src/cli/cmd/plug"
import { DbCommand } from "../../src/cli/cmd/db"
import { HelpCommand } from "../../src/kilocode/help-command"

// Stand-in for TuiThreadCommand — the real one imports @opentui/solid which
// doesn't resolve in the test environment. Only command/describe matter here.
const TuiStub = {
	command: "$0 [project]",
	describe: "start zoo tui",
	handler() {},
}

// Stand-in for AttachCommand — same reason as TuiStub above.
const AttachStub = {
	command: "attach <url>",
	describe: "attach to a running zoo server",
	handler() {},
}

// Synthetic entry for the yargs built-in .completion() command
const CompletionStub = {
	command: "completion",
	describe: "generate shell completion script",
	handler() {},
}

const commands = [
	AcpCommand,
	McpCommand,
	TuiStub,
	AttachStub,
	RunCommand,
	GenerateCommand,
	DebugCommand,
	ProvidersCommand,
	AgentCommand,
	UpgradeCommand,
	UninstallCommand,
	ServeCommand,
	WebCommand,
	ModelsCommand,
	StatsCommand,
	ExportCommand,
	ImportCommand,
	PrCommand,
	SessionCommand,
	RemoteCommand,
	DbCommand,
	ConfigCLICommand,
	PluginCommand,
	HelpCommand,
	CompletionStub,
] as any[]

describe("zoo help --all (markdown)", () => {
	test("contains ## heading for each known top-level command", async () => {
		const output = await generateHelp({ all: true, format: "md", commands })
		for (const cmd of ["run", "auth", "debug", "mcp", "session", "agent"]) {
			expect(output).toContain(`## zoo ${cmd}`)
		}
	})

	test("contains headings for nested subcommands", async () => {
		const output = await generateHelp({ all: true, format: "md", commands })
		expect(output).toContain("zoo auth login")
		expect(output).toContain("zoo auth logout")
		expect(output).toContain("zoo debug config")
	})
})

describe("zoo help --all (text)", () => {
	test("does NOT contain Markdown ## headings or triple-backtick fences", async () => {
		const output = await generateHelp({ all: true, format: "text", commands })
		expect(output).not.toMatch(/^##\s/m)
		expect(output).not.toContain("```")
	})

	test("still contains each command name", async () => {
		const output = await generateHelp({ all: true, format: "text", commands })
		for (const cmd of ["run", "auth", "debug", "mcp", "session", "agent"]) {
			expect(output).toContain(`zoo ${cmd}`)
		}
	})
})

describe("zoo help <command>", () => {
	test("zoo help auth contains auth subcommand headings", async () => {
		const output = await generateHelp({ command: "auth", format: "md", commands })
		expect(output).toContain("zoo auth login")
		expect(output).toContain("zoo auth logout")
		expect(output).toContain("zoo auth list")
	})

	test("zoo help auth does NOT contain run or debug headings", async () => {
		const output = await generateHelp({ command: "auth", format: "md", commands })
		expect(output).not.toContain("## zoo run")
		expect(output).not.toContain("## zoo debug")
	})
})

describe("edge cases", () => {
	test("output contains no ANSI escape sequences", async () => {
		const output = await generateHelp({ all: true, format: "md", commands })
		expect(/\x1b\[/.test(output)).toBe(false)
	})

	test("zoo help nonexistent throws unknown command error", async () => {
		await expect(generateHelp({ command: "nonexistent", commands })).rejects.toThrow("unknown command")
	})
})

describe("generateCommandTable", () => {
	test("returns a string containing a markdown table header", async () => {
		const output = await generateCommandTable({ commands })
		expect(output).toContain("| Command | Description |")
	})

	test("contains rows for known commands", async () => {
		const output = await generateCommandTable({ commands })
		for (const name of ["run", "auth", "debug", "mcp"]) {
			expect(output).toContain(`zoo ${name}`)
		}
	})

	test("default command appears as zoo [project], not $0", async () => {
		const output = await generateCommandTable({ commands })
		expect(output).toContain("`zoo [project]`")
		expect(output).not.toContain("$0")
	})

	test("contains no ANSI escape sequences", async () => {
		const output = await generateCommandTable({ commands })
		expect(/\x1b\[/.test(output)).toBe(false)
	})

	test("skips commands with no describe", async () => {
		const output = await generateCommandTable({ commands })
		expect(output).not.toContain("`zoo generate`")
	})

	test("contains zoo completion row", async () => {
		const output = await generateCommandTable({ commands })
		expect(output).toContain("`zoo completion`")
	})

	test("contains zoo help row", async () => {
		const output = await generateCommandTable({ commands })
		expect(output).toContain("`zoo help")
	})
})

describe("commands.ts stays in sync with index.ts", () => {
	test("every .command() in index.ts has an entry in the commands array", async () => {
		const index = await Bun.file(path.resolve(import.meta.dir, "../../src/index.ts")).text()
		const barrel = await Bun.file(path.resolve(import.meta.dir, "../../src/kilocode/commands.ts")).text()

		// Match uncommented .command(XxxCommand) calls in index.ts
		const registered = [...index.matchAll(/^\s*\.command\((\w+)\)/gm)].map((m) => m[1]!)
		expect(registered.length).toBeGreaterThan(0)

		// Extract identifiers inside the exported commands = [...] array, not just anywhere in the file
		const arrayMatch = barrel.match(/export const commands\s*=\s*\[([\s\S]*?)\]/)
		expect(arrayMatch).toBeTruthy()
		const entries = [...arrayMatch![1]!.matchAll(/\b(\w+Command)\b/g)].map((m) => m[1]!)

		const missing = registered.filter((name) => !entries.includes(name))
		expect(missing).toEqual([])
	})
})
