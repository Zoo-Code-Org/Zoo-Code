#!/usr/bin/env python3
"""Insert B04's command_output ask policy tests into merged test file."""
import subprocess

# Get B04's command_output ask policy describe block
result = subprocess.run(
    ['git', 'show', 'pr/b04-shell-contracts-v2:src/core/tools/__tests__/executeCommandTool.spec.ts'],
    capture_output=True, text=True, encoding='utf-8'
)
b04_lines = result.stdout.split('\n')

# Find the describe('command_output ask policy') block
start = None
for i, line in enumerate(b04_lines):
    if 'command_output ask policy' in line:
        start = i - 1  # include the describe line
        break

if start is None:
    print('ERROR: command_output ask policy not found in B04')
    exit(1)

# Find the closing of this describe block by counting braces
depth = 0
end = None
for i in range(start, len(b04_lines)):
    depth += b04_lines[i].count('{') - b04_lines[i].count('}')
    if depth == 0 and i > start:
        end = i + 1
        break

if end is None:
    print('ERROR: No closing brace found')
    exit(1)

# Extract the block
b04_block = '\n'.join(b04_lines[start:end])
print(f"Extracted B04 block: lines {start+1} to {end} ({end - start} lines)")

# Read the current merged test file
filepath = "src/core/tools/__tests__/executeCommandTool.spec.ts"
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Insert the B04 block before the "cwd parameter validation" describe
insertion_point = '\tdescribe("cwd parameter validation", () => {'
if insertion_point not in content:
    print('ERROR: cwd parameter validation not found in merged file')
    exit(1)

# Insert with a blank line separator
content = content.replace(
    insertion_point,
    b04_block + '\n\n' + insertion_point
)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print("Successfully inserted B04 command_output ask policy tests")
