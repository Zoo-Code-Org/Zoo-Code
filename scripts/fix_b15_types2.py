import re

# Fix vscode-lm.ts
f = 'src/api/providers/vscode-lm.ts'
c = open(f, 'r', encoding='utf-8').read()

# Line 357: 'cleaned' is of type 'unknown' - need to cast it
# The variable 'cleaned' was declared as 'unknown' (from 'any' replacement)
# Need to find the declaration and cast it
c = c.replace(
    'const cleaned = ',
    'const cleaned = '
)

# Actually, let's just add 'as string' or 'as Record<string, unknown>' where needed
# Let's read the actual lines to understand the context

lines = c.split('\n')
for i, line in enumerate(lines, 1):
    if 350 <= i <= 360 or 378 <= i <= 388:
        print(f"vscode-lm.ts:{i}: {line}")

# Fix vscode-lm-format.spec.ts
f2 = 'src/api/transform/__tests__/vscode-lm-format.spec.ts'
c2 = open(f2, 'r', encoding='utf-8').read()
lines2 = c2.split('\n')
for i, line in enumerate(lines2, 1):
    if 185 <= i <= 195 or 207 <= i <= 217 or 218 <= i <= 225 or 242 <= i <= 250 or 252 <= i <= 260 or 262 <= i <= 270 or 273 <= i <= 285 or 288 <= i <= 300 or 310 <= i <= 320 or 325 <= i <= 335 or 350 <= i <= 360 or 363 <= i <= 370 or 380 <= i <= 390 or 398 <= i <= 410 or 418 <= i <= 430 or 430 <= i <= 440:
        print(f"spec:{i}: {line}")
