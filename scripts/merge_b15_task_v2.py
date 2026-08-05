"""
3-way merge of Task.ts: take b14's version (with telemetry) and apply b15's usage capture additions.

Strategy:
1. Start with b14's Task.ts (has telemetry methods)
2. Find b15-specific additions (lines in b15 not in b14)
3. Insert them at the appropriate locations
"""
import subprocess

# Get b14's Task.ts
result = subprocess.run(['git', 'show', 'bae2ac99a:src/core/task/Task.ts'], capture_output=True, text=True, encoding='utf-8')
b14_lines = result.stdout.splitlines()

# Get b15's Task.ts
result = subprocess.run(['git', 'show', '334ba27f0:src/core/task/Task.ts'], capture_output=True, text=True, encoding='utf-8')
b15_lines = result.stdout.splitlines()

# Create a set of b14 lines for quick lookup
b14_set = set(line.strip() for line in b14_lines if line.strip())

# Find contiguous blocks of b15-specific additions
# A block is a sequence of lines in b15 that don't exist in b14
blocks = []
current_block = []
current_block_start = None

for i, line in enumerate(b15_lines):
    stripped = line.strip()
    if stripped and stripped not in b14_set:
        if current_block_start is None:
            current_block_start = i
        current_block.append(line)
    else:
        if current_block:
            blocks.append((current_block_start, current_block))
            current_block = []
            current_block_start = None

if current_block:
    blocks.append((current_block_start, current_block))

# Filter out blocks that are just whitespace or comments
# Also filter out blocks that are clearly b15-specific (usage stats related)
usage_blocks = []
for start, block in blocks:
    block_text = '\n'.join(block)
    # Skip if it's just the file header or empty
    if not any(line.strip() for line in block):
        continue
    # Check if this block contains usage stats related code
    if any(kw in block_text for kw in ['UsageRecorder', 'UsageRecordingContext', 'UsageEventStore', 'PROVIDER_DEFAULT_BASE_URLS', 'getProviderBaseUrlField', 'extractEndpointDomain', 'usageRecorder', 'usageRecordingContext', 'usageEventStore', 'recordUsage', 'UsageStatsService']):
        usage_blocks.append((start, block))
        continue
    # Also check for imports that b15 added
    if any(kw in block_text for kw in ['import { UsageRecorder', 'import type { UsageRecordingContext']):
        usage_blocks.append((start, block))
        continue
    # Check for the shouldAddUserMessageToHistory removal (b15 removed this import)
    if 'shouldAddUserMessageToHistory' in block_text:
        continue  # Skip - this is a removal, not an addition
    # Check for providerIdentifiers removal
    if 'providerIdentifiers' in block_text:
        continue  # Skip - this is a removal

print(f"Found {len(usage_blocks)} usage-related blocks to apply")
for i, (start, block) in enumerate(usage_blocks):
    print(f"\nBlock {i+1} (b15 line {start+1}):")
    for line in block[:5]:
        print(f"  {line[:100]}")
    if len(block) > 5:
        print(f"  ... ({len(block)} lines total)")

# Now we need to insert these blocks into b14's Task.ts
# The challenge is finding the right insertion points
# Strategy: for each block, find the nearest preceding line in b14 that matches the preceding line in b15

b14_line_set = set(line.strip() for line in b14_lines if line.strip())
result_lines = b14_lines[:]

# Process blocks in reverse order so insertions don't affect earlier line numbers
for start, block in reversed(usage_blocks):
    # Find the preceding line in b15 (the line before the block)
    if start > 0:
        preceding_line = b15_lines[start - 1].strip()
        # Find this line in b14
        insert_idx = None
        for i, line in enumerate(result_lines):
            if line.strip() == preceding_line:
                insert_idx = i + 1
                break
        
        if insert_idx is not None:
            # Insert the block
            for j, line in enumerate(block):
                result_lines.insert(insert_idx + j, line)
            print(f"Inserted block at b14 line {insert_idx + 1} ({len(block)} lines)")
        else:
            print(f"WARNING: Could not find insertion point for block starting at b15 line {start+1}")
            print(f"  Preceding line: {preceding_line[:100]}")

# Write the result
with open('src/core/task/Task.ts', 'w', encoding='utf-8') as f:
    f.write('\n'.join(result_lines))

print(f"\nDone. Result has {len(result_lines)} lines")
