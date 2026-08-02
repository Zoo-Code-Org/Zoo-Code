f = 'src/api/transform/__tests__/vscode-lm-format.spec.ts'
c = open(f, 'r', encoding='utf-8').read()

# The spec file has patterns like:
# const image = { ... } as unknown  (was 'as any')
# const toolResult = { ... } as unknown  (was 'as any')
# These need to be 'as unknown as Record<string, unknown>' for property access

# Replace 'as unknown' at end of object literals with 'as unknown as Record<string, unknown>'
# But only when followed by property access

# Actually, let's just replace all 'as unknown' (not 'as unknown as') with 'as unknown as Record<string, unknown>'
import re

# Find all 'as unknown' that are NOT followed by ' as'
c = re.sub(r'as unknown(?! as)', 'as unknown as Record<string, unknown>', c)

# Also fix the function calls that pass unknown to typed parameters
# LanguageModelChatMessageRole and LanguageModelChatMessage casts
c = c.replace(
    'vscode.LanguageModelChatMessage.Role',
    'vscode.LanguageModelChatMessage.Role as unknown as vscode.LanguageModelChatMessageRole'
)

open(f, 'w', encoding='utf-8').write(c)
print('Done')
