#!/usr/bin/env python3
"""Resolve merge conflicts in ExecuteCommandTool.ts for B05 cherry-pick."""
import sys

filepath = "src/core/tools/ExecuteCommandTool.ts"

with open(filepath, "r", encoding="utf-8") as f:
    lines = f.readlines()

result = []
i = 0
while i < len(lines):
    line = lines[i]
    
    if line.startswith("<<<<<<< HEAD"):
        # Collect HEAD section
        head_section = []
        i += 1
        while not lines[i].startswith("======="):
            head_section.append(lines[i])
            i += 1
        i += 1  # skip =======
        
        # Collect THEIRS section
        theirs_section = []
        while not lines[i].startswith(">>>>>>> "):
            theirs_section.append(lines[i])
            i += 1
        i += 1  # skip >>>>>>> ...
        
        # Now resolve based on content
        head_text = "".join(head_section)
        theirs_text = "".join(theirs_section)
        
        # Conflict 1: ShellFallbackMismatchError + COMMAND_OUTPUT_ASK_DELAY_MS + enhanced getTerminalProviderForExecution
        if "ShellFallbackMismatchError" in theirs_text and "COMMAND_OUTPUT_ASK_DELAY_MS" in head_text:
            # Keep theirs first (ShellFallbackMismatchError), then head (COMMAND_OUTPUT_ASK_DELAY_MS), then enhanced signature
            result.append(" * Error thrown when shell integration fails and no same-family fallback plan\n")
            result.append(" * is available. The command must NOT be retried under a different shell family.\n")
            result.append(" */\n")
            result.append("export class ShellFallbackMismatchError extends Error {\n")
            result.append("\treadonly code = \"SHELL_FALLBACK_MISMATCH\" as const\n")
            result.append("\treadonly primaryFamily: string\n")
            result.append("\treadonly fallbackFamily: string | undefined\n")
            result.append("\n")
            result.append("\tconstructor(primaryFamily: string, fallbackFamily: string | undefined) {\n")
            result.append("\t\tsuper(\n")
            result.append("\t\t\t`SHELL_FALLBACK_MISMATCH: Primary shell family \"${primaryFamily}\" has no compatible fallback` +\n")
            result.append("\t\t\t\t(fallbackFamily ? ` (fallback family: \"${fallbackFamily}\")` : \" (no fallback plan available)\") +\n")
            result.append("\t\t\t\t\". Command was not executed.\",\n")
            result.append("\t\t)\n")
            result.append("\t\tthis.name = \"ShellFallbackMismatchError\"\n")
            result.append("\t\tthis.primaryFamily = primaryFamily\n")
            result.append("\t\tthis.fallbackFamily = fallbackFamily\n")
            result.append("\t}\n")
            result.append("}\n")
            result.append("\n")
            result.append("/**\n")
            result.append(" * Grace period before a foreground command may trigger a `command_output` ask.\n")
            result.append(" * Short commands that emit output and exit within this window never prompt the\n")
            result.append(" * user; the ask only fires when the command is still running once the delay\n")
            result.append(" * elapses, so users can still interrupt or provide feedback on long-running\n")
            result.append(" * commands.\n")
            result.append(" */\n")
            result.append("export const COMMAND_OUTPUT_ASK_DELAY_MS = 5_000\n")
            result.append("\n")
            result.append("/**\n")
            result.append(" * Determines the terminal provider for command execution.\n")
            result.append(" *\n")
            result.append(" * When a {@link ResolvedCommandEnvironment} is provided, the provider is\n")
            result.append(" * determined from `primaryPlan.provider` — this is the single source of truth\n")
            result.append(" * that matches the system prompt and tool description.\n")
            result.append(" *\n")
            result.append(" * When no environment is provided (legacy callers), falls back to the\n")
            result.append(" * original `terminalShellIntegrationDisabled` + `isActiveShellCmdExe()` logic.\n")
            result.append(" *\n")
            result.append(" * @param terminalShellIntegrationDisabled Whether shell integration is disabled.\n")
            result.append(" * @param env Optional resolved command environment snapshot.\n")
            result.append(" * @returns The terminal provider and whether this is a cmd.exe fallback.\n")
            result.append(" */\n")
            result.append("export function getTerminalProviderForExecution(\n")
            result.append("\tterminalShellIntegrationDisabled: boolean,\n")
            result.append("\tenv?: ResolvedCommandEnvironment,\n")
            result.append("): {\n")
        
        # Conflict 2: onShellExecutionStarted - keep process param from HEAD + traceBuilder from THEIRS
        elif "onShellExecutionStarted" in head_text and "traceBuilder" in theirs_text:
            result.append("\t\tonShellExecutionStarted: (pid: number | undefined, process: RooTerminalProcess) => {\n")
            result.append("\t\t\tconst now = Date.now()\n")
            result.append("\t\t\ttraceBuilder?.markProcessIdResolvedAt(now)\n")
            result.append("\t\t\ttraceBuilder?.markShellExecutionStartedAt(now)\n")
        
        # Conflict 3: runCommand - keep commandStartedAt from HEAD + ExecaTerminal plan from THEIRS
        elif "commandStartedAt" in head_text and "ExecaTerminal" in theirs_text:
            result.append("\t// Fallback anchor for providers that never fire onShellExecutionStarted.\n")
            result.append("\tcommandStartedAt = Date.now()\n")
            result.append("\n")
            result.append("\t// When using execa with a resolved environment, set the shell invocation\n")
            result.append("\t// plan so ExecaTerminalProcess uses the family-specific adapter instead of\n")
            result.append("\t// the legacy `shell: true` path. On the retry path, use the fallback plan.\n")
            result.append("\tif (terminal instanceof ExecaTerminal && resolvedEnv) {\n")
            result.append("\t\tconst plan: ShellInvocationPlan | undefined = useFallbackPlan\n")
            result.append("\t\t\t? resolvedEnv.fallbackPlan\n")
            result.append("\t\t\t: resolvedEnv.primaryPlan\n")
            result.append("\t\tif (plan) {\n")
            result.append("\t\t\tterminal.setShellInvocationPlan(plan)\n")
            result.append("\t\t}\n")
            result.append("\t}\n")
            result.append("\n")
            result.append("\ttraceBuilder?.markCommandSubmittedAt(Date.now())\n")
            result.append("\tconst process = terminal.runCommand(command, callbacks, executionId)\n")
        
        else:
            print(f"ERROR: Unknown conflict at line {i}")
            print(f"  HEAD: {head_text[:100]}")
            print(f"  THEIRS: {theirs_text[:100]}")
            sys.exit(1)
    else:
        result.append(line)
        i += 1

# Verify no conflict markers remain
remaining = [l for l in result if l.startswith("<<<<<<<") or l.startswith("=======") or l.startswith(">>>>>>>")]
if remaining:
    print(f"WARNING: {len(remaining)} conflict markers remain")
    for l in remaining:
        print(f"  {l.strip()[:80]}")
    sys.exit(1)
else:
    print("All conflicts resolved successfully")

with open(filepath, "w", encoding="utf-8") as f:
    f.writelines(result)
