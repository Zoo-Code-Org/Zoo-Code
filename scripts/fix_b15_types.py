import re

# Fix Task.ts: .run() → .start() in specific locations
# The B15 Task.ts (theirs) uses .run() but v2 base uses .start()
# We need to find where Task.ts calls .run() and change to .start()
# But only for Task instances, not other objects

# Fix vscode-lm.ts: replace 'unknown' with proper types
f = 'src/api/providers/vscode-lm.ts'
c = open(f, 'r', encoding='utf-8').read()

# Line 341: two 'any' → 'unknown' replacements need to be 'Record<string, unknown>'
# The pattern is likely function params or variable types
# Let's read the actual lines and fix them

# Fix vscode-lm-format.ts: line 7 'any' → 'unknown' 
f2 = 'src/api/transform/vscode-lm-format.ts'
c2 = open(f2, 'r', encoding='utf-8').read()

# Fix vscode-lm-format.spec.ts: many 'any' → 'unknown' replacements
# These need to be cast properly
f3 = 'src/api/transform/__tests__/vscode-lm-format.spec.ts'
c3 = open(f3, 'r', encoding='utf-8').read()

print("Files loaded, checking patterns...")

# For vscode-lm.ts, the 'unknown' types need to be cast back to specific types
# Let's just print the relevant lines
lines = c.split('\n')
for i, line in enumerate(lines, 1):
    if 339 <= i <= 360 or 380 <= i <= 390:
        print(f"vscode-lm.ts:{i}: {line}")

print("\n--- vscode-lm-format.ts ---")
lines2 = c2.split('\n')
for i, line in enumerate(lines2, 1):
    if 5 <= i <= 10:
        print(f"vscode-lm-format.ts:{i}: {line}")

print("\n--- vscode-lm-format.spec.ts (first 30 lines) ---")
lines3 = c3.split('\n')
for i, line in enumerate(lines3, 1):
    if 20 <= i <= 30:
        print(f"spec:{i}: {line}")
