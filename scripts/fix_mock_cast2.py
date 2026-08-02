f = 'src/core/task/__tests__/Task.usage-stats.spec.ts'
c = open(f, 'r', encoding='utf-8').read()
# Fix the mangled replacement
old_str = 'as unknown as import(" vitest\\).Mock'
new_str = 'as unknown as vi.Mock'
c = c.replace(old_str, new_str)
open(f, 'w', encoding='utf-8').write(c)
print('Done - replaced', c.count(new_str), 'occurrences')
