import re
import sys

filepath = sys.argv[1]
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace : any with : unknown in type annotations
# Replace as any with as unknown
# Replace <any> with <unknown>
content = content.replace(': any', ': unknown')
content = content.replace(': any)', ': unknown)')
content = content.replace(' as any', ' as unknown')
content = content.replace('<any>', '<unknown>')
content = content.replace(' any>', ' unknown>')
content = content.replace('(any)', '(unknown)')
content = content.replace(', any)', ', unknown)')

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"Fixed {filepath}")
