import re

f = 'src/api/transform/__tests__/vscode-lm-format.spec.ts'
c = open(f, 'r', encoding='utf-8').read()

# Replace 'as unknown as Record<string, unknown>' with 'as unknown as never'
# 'never' is assignable to everything, so it works as a type assertion target
# This is a common pattern for test mocks
c = c.replace('as unknown as Record<string, unknown>', 'as unknown as never')

open(f, 'w', encoding='utf-8').write(c)
print('Done')
