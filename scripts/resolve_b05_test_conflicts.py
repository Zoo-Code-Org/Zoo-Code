#!/usr/bin/env python3
"""Resolve merge conflicts in executeCommandTool.spec.ts for B05 merge."""

filepath = "src/core/tools/__tests__/executeCommandTool.spec.ts"

with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# Split by conflict markers
head_marker = "<<<<<<< HEAD\n"
sep_marker = "\n=======\n"
theirs_marker = "\n>>>>>>> feature/unified-shell-resolution\n"

parts = content.split(head_marker)
if len(parts) != 3:
    print(f"ERROR: Expected 2 conflict regions, found {len(parts) - 1}")
    exit(1)

# parts[0] = everything before first conflict
# parts[1] = HEAD1 ======= THEIRS1 >>>>>>> shared <<<<<<< HEAD2 ======= THEIRS2 >>>>>>> remaining
# parts[2] = HEAD2 ======= THEIRS2 >>>>>>> remaining

# Parse first conflict from parts[1]
mid1 = parts[1].split(sep_marker, 1)
head1 = mid1[0]
theirs1_and_shared = mid1[1]
theirs1_split = theirs1_and_shared.split(theirs_marker, 1)
theirs1 = theirs1_split[0]
shared_and_second = theirs1_split[1]

# shared_and_second contains: shared lines + <<<<<<< HEAD\n + second conflict
# Find the second HEAD marker
shared_split = shared_and_second.split(head_marker, 1)
shared_lines = shared_split[0]
# shared_split[1] should be the same as parts[2]... but wait, parts[2] is already split

# Actually parts[2] is what comes after the SECOND <<<<<<< HEAD marker
# So shared_lines is the shared code between the two conflicts
# And parts[2] contains: HEAD2 ======= THEIRS2 >>>>>>> remaining

mid2 = parts[2].split(sep_marker, 1)
head2 = mid2[0]
theirs2_and_rest = mid2[1]
theirs2_split = theirs2_and_rest.split(theirs_marker, 1)
theirs2 = theirs2_split[0]
remaining = theirs2_split[1]

print("=== HEAD1 (first 100 chars) ===")
print(head1[:100])
print("=== THEIRS1 (first 100 chars) ===")
print(theirs1[:100])
print("=== SHARED (first 200 chars) ===")
print(shared_lines[:200])
print("=== HEAD2 (first 100 chars) ===")
print(head2[:100])
print("=== THEIRS2 (first 100 chars) ===")
print(theirs2[:100])
print("=== REMAINING (first 100 chars) ===")
print(remaining[:100])

# Build resolved content:
# 1. parts[0] (before first conflict)
# 2. HEAD1 (command_output describe, ends with handle call)
# 3. shared_lines (askApproval, handleError, pushToolResult, }))
# 4. HEAD2 (} + more tests + Exit code: 0)
# 5. Close HEAD's describe: })
# 6. Blank line
# 7. THEIRS1 (cwd describe, ends with handle call)
# 8. shared_lines (askApproval, handleError, pushToolResult, }))
# 9. THEIRS2 (expect + more cwd tests + not.toHaveBeenCalled)
# 10. remaining (})\n})\n})\n

resolved = parts[0]
resolved += head1
resolved += shared_lines
resolved += head2
resolved += "\t})\n"  # close command_output ask policy describe
resolved += "\n"
resolved += theirs1
resolved += shared_lines
resolved += theirs2
resolved += remaining

# Verify no conflict markers remain
if "<<<<<<<" in resolved or "=======" in resolved or ">>>>>>>" in resolved:
    print("ERROR: Conflict markers remain")
    for i, line in enumerate(resolved.split("\n")):
        if line.startswith("<<<<<<<") or line.startswith("=======") or line.startswith(">>>>>>>"):
            print(f"  Line {i+1}: {line[:80]}")
    exit(1)
else:
    print("All conflicts resolved successfully")

with open(filepath, "w", encoding="utf-8") as f:
    f.write(resolved)
