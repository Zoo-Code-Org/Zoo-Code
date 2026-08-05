#!/usr/bin/env python3
"""Analyze git diff to identify added lines per source file for coverage analysis."""
import subprocess
import re
import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "992585ff8b7bdc750ecf2b79372f5be4d2e5ff71"

source_files = [
    "packages/telemetry/src/TelemetryService.ts",
    "packages/types/src/model.ts",
    "packages/types/src/provider-settings.ts",
    "packages/types/src/providers/mimo.ts",
    "packages/types/src/telemetry.ts",
    "src/api/index.ts",
    "src/api/providers/base-openai-compatible-provider.ts",
    "src/api/providers/base-provider.ts",
    "src/api/providers/mimo.ts",
    "src/api/providers/openai.ts",
    "src/core/assistant-message/NativeToolCallParser.ts",
    "src/core/assistant-message/ToolCallRetentionPolicy.ts",
    "src/core/prompts/tools/native-tools/execute_command.ts",
    "src/core/task/Task.ts",
    "src/core/tools/ExecuteCommandTool.ts",
    "src/shared/tools.ts",
]

result = subprocess.run(
    ["git", "diff", f"{BASE}...HEAD"],
    capture_output=True,
    text=True,
    cwd=REPO,
)
diff = result.stdout

current_file = None
added_lines = {}

for line in diff.split("\n"):
    if line.startswith("diff --git"):
        m = re.search(r"diff --git a/(.+?) b/", line)
        if m:
            current_file = m.group(1)
            added_lines[current_file] = []
    elif line.startswith("@@"):
        m = re.search(r"\+(\d+)(?:,(\d+))?", line)
        if m and current_file:
            new_start = int(m.group(1))
            added_lines[current_file].append({"hunk_start": new_start, "lines": []})
    elif line.startswith("+") and not line.startswith("+++"):
        if current_file and added_lines[current_file]:
            added_lines[current_file][-1]["lines"].append(line[1:])

for f in source_files:
    if f in added_lines and added_lines[f]:
        total_added = sum(len(h["lines"]) for h in added_lines[f])
        print(f"=== {f}: {total_added} added lines ===")
        for hunk in added_lines[f]:
            start = hunk["hunk_start"]
            count = len(hunk["lines"])
            end = start + count - 1
            print(f"  Lines {start}-{end} ({count} lines)")
            for i, l in enumerate(hunk["lines"]):
                print(f"    {start + i}: {l.rstrip()}")
    else:
        print(f"=== {f}: NO CHANGES ===")
