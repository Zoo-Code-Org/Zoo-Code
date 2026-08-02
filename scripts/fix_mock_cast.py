f = 'src/core/task/__tests__/Task.usage-stats.spec.ts'
c = open(f, 'r', encoding='utf-8').read()
old = 'as unknown as import("vitest").Mock'
new = 'as unknown as vi.Mock'
c = c.replace(old, new)
open(f, 'w', encoding='utf-8').write(c)
print('Done')
