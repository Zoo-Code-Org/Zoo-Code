import re

def resolve_keep_both(filepath, branch_name):
    """Resolve conflicts by keeping both HEAD and branch additions."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
    
    pattern = r'<<<<<<< HEAD\n|=======\n|>>>>>>> ' + re.escape(branch_name) + r'\n'
    parts = re.split(pattern, content)
    
    if len(parts) == 1:
        print(f"  {filepath}: No conflicts found")
        return
    
    resolved = parts[0]
    i = 1
    while i < len(parts):
        if i + 1 < len(parts):
            head_part = parts[i]
            branch_part = parts[i + 1]
            
            # If branch part is empty, just keep HEAD
            if branch_part.strip() == "":
                resolved += head_part
            # If HEAD part is empty, just keep branch
            elif head_part.strip() == "":
                resolved += branch_part
            # Both have content - keep both
            else:
                resolved += head_part
                resolved += branch_part
            i += 2
        else:
            resolved += parts[i]
            i += 1
    
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(resolved)
    
    # Verify
    with open(filepath, "r", encoding="utf-8") as f:
        c = f.read()
    remaining = c.count("<<<<<<< HEAD") + c.count(">>>>>>> " + branch_name)
    print(f"  {filepath}: Resolved (keep both), remaining markers: {remaining}")

print("Resolving vscode-extension-host.ts...")
resolve_keep_both("packages/types/src/vscode-extension-host.ts", "feature/task-dnd-ux")

print("\nResolving webviewMessageHandler.ts...")
resolve_keep_both("src/core/webview/webviewMessageHandler.ts", "feature/task-dnd-ux")

# Final verification
print("\n=== Final Verification ===")
files = [
    "packages/types/src/vscode-extension-host.ts",
    "src/core/webview/webviewMessageHandler.ts",
]
for f in files:
    with open(f, "r", encoding="utf-8") as fh:
        c = fh.read()
    head = c.count("<<<<<<< HEAD")
    dnd = c.count(">>>>>>> feature/task-dnd-ux")
    print(f"  {f}: HEAD={head}, DND={dnd}")
