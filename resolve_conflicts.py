import re

filepath = 'packages/types/src/vscode-extension-host.ts'

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Pattern to match conflict blocks
# Conflict 1: response types
pattern1 = re.compile(
    r'<<<<<<< HEAD\n'
    r'\t// Terminal shell options response type\n'
    r'\t\| "terminalShellOptions"\n'
    r'\t// Usage stats response types\n'
    r'\t\| "getUsageStatsResponse"\n'
    r'\t\| "clearUsageStatsResponse"\n'
    r'\t\| "exportUsageStatsResponse"\n'
    r'\t\| "requestClearNonceResponse"\n'
    r'\t\| "usageStatsChanged"\n'
    r'\t// Dashboard response types\n'
    r'\t\| "dashboardStatsResponse"\n'
    r'\t\| "dashboardSessionsResponse"\n'
    r'\t\| "dashboardSessionDetailResponse"\n'
    r'\t\| "taskOrganizationUpdated"\n'
    r'\t\| "taskOrganizationMutationResult"\n'
    r'=======\n'
    r'(.*?)\n'
    r'>>>>>>> e5d618acf.*?\n',
    re.DOTALL
)

resolution1 = (
    '\t// Terminal shell options response type\n'
    '\t| "terminalShellOptions"\n'
    '\t// Usage stats response types\n'
    '\t| "getUsageStatsResponse"\n'
    '\t| "clearUsageStatsResponse"\n'
    '\t| "exportUsageStatsResponse"\n'
    '\t| "requestClearNonceResponse"\n'
    '\t| "usageStatsChanged"\n'
    '\t// Dashboard response types\n'
    '\t| "dashboardStatsResponse"\n'
    '\t| "dashboardSessionsResponse"\n'
    '\t| "dashboardSessionDetailResponse"\n'
    '\t// Dashboard streaming response types\n'
    '\t| "dashboardStatsStreamSnapshot"\n'
    '\t| "dashboardStatsStreamDelta"\n'
    '\t| "dashboardStatsStreamError"\n'
    '\t| "dashboardSessionPageResponse"\n'
    '\t| "taskOrganizationUpdated"\n'
    '\t| "taskOrganizationMutationResult"\n'
)

def replace_conflict(match):
    incoming = match.group(1)
    # Extract the streaming-specific lines from incoming (the ones not in HEAD)
    # We want the full incoming content but with tab indentation (not tab+tab)
    lines = incoming.split('\n')
    fixed_lines = []
    for line in lines:
        if line.startswith('\t\t'):
            fixed_lines.append(line[1:])  # remove one tab
        else:
            fixed_lines.append(line)
    return '\n'.join(fixed_lines) + '\n'

content = pattern1.sub(replace_conflict, content)

# Conflict 2: request types
pattern2 = re.compile(
    r'<<<<<<< HEAD\n'
    r'\t// Terminal shell selection messages\n'
    r'\t\| "requestTerminalShellOptions"\n'
    r'\t\| "setTerminalShellSelection"\n'
    r'\t\| "requestCustomShellPath"\n'
    r'\t// Usage stats request types\n'
    r'\t\| "getUsageStats"\n'
    r'\t\| "clearUsageStats"\n'
    r'\t\| "exportUsageStats"\n'
    r'\t\| "requestClearNonce"\n'
    r'\t// Dashboard request types\n'
    r'\t\| "getDashboardStats"\n'
    r'\t\| "getDashboardSessionDetail"\n'
    r'\t\| "getDashboardSessions"\n'
    r'\t\| "taskOrganizationMutation"\n'
    r'=======\n'
    r'(.*?)\n'
    r'>>>>>>> e5d618acf.*?\n',
    re.DOTALL
)

content = pattern2.sub(replace_conflict, content)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

# Verify no conflict markers remain
with open(filepath, 'r', encoding='utf-8') as f:
    final = f.read()

if '<<<<<<< HEAD' in final or '=======' in final or '>>>>>>> ' in final:
    print("WARNING: Conflict markers still present!")
else:
    print("All conflicts resolved successfully")
