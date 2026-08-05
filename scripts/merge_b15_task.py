"""
Merge b15's usage capture additions into b14's Task.ts (which has telemetry methods).

Strategy: Read b15's Task.ts, extract the usage-capture-specific blocks,
and insert them into b14's Task.ts at the appropriate locations.
"""
import subprocess
import re

# Get b15's version of Task.ts
result = subprocess.run(['git', 'show', '334ba27f0:src/core/task/Task.ts'], capture_output=True, text=True, encoding='utf-8')
b15_lines = result.stdout.splitlines()

# Read b14's version (current file)
with open('src/core/task/Task.ts', 'r', encoding='utf-8') as f:
    b14_content = f.read()
    b14_lines = b14_content.splitlines()

# Step 1: Add imports for UsageRecorder
# Find the RepoPerTaskCheckpointService import line in b14
b14_import_idx = None
for i, line in enumerate(b14_lines):
    if 'RepoPerTaskCheckpointService' in line and 'import' in line:
        b14_import_idx = i
        break

if b14_import_idx is not None:
    b14_lines.insert(b14_import_idx + 1, 'import { UsageRecorder } from "../../services/stats"')
    b14_lines.insert(b14_import_idx + 2, 'import type { UsageRecordingContext, UsageEventStore } from "../../services/stats"')
    print(f"Added imports after line {b14_import_idx + 1}")
else:
    print("ERROR: Could not find RepoPerTaskCheckpointService import")

# Step 2: Add the PROVIDER_DEFAULT_BASE_URLS, getProviderBaseUrlField, extractEndpointDomain
# These are new functions/constants added by b15 after the existing constants
# Find the line with MAX_CONTEXT_WINDOW_RETRIES in b14
b14_const_idx = None
for i, line in enumerate(b14_lines):
    if 'MAX_CONTEXT_WINDOW_RETRIES' in line:
        b14_const_idx = i
        break

# Extract the usage stats helper code from b15 (lines 145-240 approximately)
# Find the block between "// ── Usage Stats" and the next non-usage section
usage_stats_block = []
in_block = False
for line in b15_lines:
    if '// ── Usage Stats: endpoint domain extraction' in line:
        in_block = True
    if in_block:
        usage_stats_block.append(line)
    # End when we hit the next major section (a class declaration or similar)
    if in_block and line.strip().startswith('export class') or (in_block and line.strip().startswith('export abstract class')):
        break

# Remove the last line (the class declaration) from the block
if usage_stats_block and (usage_stats_block[-1].strip().startswith('export class') or usage_stats_block[-1].strip().startswith('export abstract class')):
    usage_stats_block.pop()

# Add a blank line before and after
if b14_const_idx is not None:
    # Find the end of the constants block (next blank line after MAX_CONTEXT_WINDOW_RETRIES)
    insert_idx = b14_const_idx + 1
    # Skip to end of the constant declaration
    while insert_idx < len(b14_lines) and b14_lines[insert_idx].strip():
        insert_idx += 1
    # Insert the usage stats block
    for j, line in enumerate(usage_stats_block):
        b14_lines.insert(insert_idx + 1 + j, line)
    print(f"Added usage stats helper block at line {insert_idx + 1} ({len(usage_stats_block)} lines)")
else:
    print("ERROR: Could not find MAX_CONTEXT_WINDOW_RETRIES")

# Write the result
with open('src/core/task/Task.ts', 'w', encoding='utf-8') as f:
    f.write('\n'.join(b14_lines))

print(f"Done. File now has {len(b14_lines)} lines")
