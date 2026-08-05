# Final continuation: squash remaining 12 branches
# Auto-resolves ALL merge conflicts with --theirs

$repoRoot = "c:/Users/k1yt/OneDrive/Projects/ZooCode"
Set-Location $repoRoot

$prs = @(
    @{ name="pr/b02-error-runtime-v2";      base="temp/pr/b01-error-contracts-v2";   message="feat: add error interception runtime and task error state";                source="myk1yt/pr/b02-error-runtime-v2" }
    @{ name="pr/b09-task-org-ipc-v2";       base="temp/pr/b08-task-persistence-v2";  message="feat: add task organization message handler and webview IPC";              source="myk1yt/pr/b09-task-org-ipc-v2" }
    @{ name="pr/b14-usage-aggregation-v2";  base="temp/pr/b13-usage-store-v2";      message="feat: add usage aggregation, cost recalculation, and service";             source="myk1yt/pr/b14-usage-aggregation-v2" }
    @{ name="pr/b12-mimo-enforcement-v2";   base="temp/pr/b05a-strict-reasoning-v2"; message="fix: add MiMo parallel tool call policy, ghost quarantine, and retention"; source="myk1yt/pr/b12-mimo-enforcement-v2" }
    @{ name="pr/b17-provider-cost-v2";      base="temp/pr/b05a-strict-reasoning-v2"; message="feat: add provider cost normalization and usage field handling";          source="myk1yt/pr/b17-provider-cost-v2" }
    @{ name="pr/b06-terminal-lifecycle-v2"; base="temp/pr/b05-shell-resolution-v2";  message="feat: add terminal lifecycle, command scheduler, registry, and trace";     source="myk1yt/pr/b06-terminal-lifecycle-v2" }
    @{ name="pr/b03-error-integration-v2";  base="temp/pr/b02-error-runtime-v2";     message="feat: integrate error interception into assistant message presentation";  source="myk1yt/pr/b03-error-integration-v2" }
    @{ name="pr/b10-task-org-ui-v2";        base="temp/pr/b09-task-org-ipc-v2";      message="feat: add task organization DnD UI, dialogs, and optimistic reconciliation"; source="myk1yt/pr/b10-task-org-ui-v2" }
    @{ name="pr/b15-usage-capture-v2";      base="temp/pr/b14-usage-aggregation-v2"; message="feat: add exactly-once usage capture from task API completion";          source="myk1yt/pr/b15-usage-capture-v2" }
    @{ name="pr/b07-shell-integration-v2";  base="temp/pr/b06-terminal-lifecycle-v2"; message="feat: wire shell resolver and lifecycle to task, command tool, and API"; source="myk1yt/pr/b07-shell-integration-v2" }
    @{ name="pr/b16-stats-ui-v2";           base="temp/pr/b15-usage-capture-v2";      message="feat: add SQLite projection, migration, stream IPC, and dashboard UI";     source="myk1yt/pr/b16-stats-ui-v2" }
)

$results = @()
$successCount = 0
$failCount = 0

foreach ($pr in $prs) {
    $branchName = $pr.name
    $baseBranch = $pr.base
    $commitMessage = $pr.message
    $sourceBranch = $pr.source
    $tempBranch = "temp/$branchName"

    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "Processing: $branchName" -ForegroundColor Cyan
    Write-Host "  Base: $baseBranch | Source: $sourceBranch" -ForegroundColor Gray
    Write-Host "==========================================" -ForegroundColor Cyan

    # Step 1: Create temp branch from base
    git checkout -B $tempBranch $baseBranch 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: checkout" -ForegroundColor Red
        $results += [PSCustomObject]@{ Branch=$branchName; Status="FAILED"; Error="checkout" }
        $failCount++; break
    }

    # Step 2: Squash merge
    $mergeOutput = git merge --squash $sourceBranch 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Merge conflict, auto-resolving with --theirs..." -ForegroundColor DarkYellow
        # Resolve ALL conflicted files with --theirs
        $conflicted = git diff --name-only --diff-filter=U 2>&1
        foreach ($file in $conflicted) {
            if ($file -and $file.Trim()) {
                git checkout --theirs $file.Trim() 2>&1 | Out-Null
                git add $file.Trim() 2>&1 | Out-Null
                Write-Host "    Resolved: $file" -ForegroundColor DarkGray
            }
        }
    }

    # Step 3: Commit
    git commit -m $commitMessage --no-verify 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $statusOutput = git status --porcelain 2>&1
        if ([string]::IsNullOrWhiteSpace($statusOutput)) {
            Write-Host "  Empty squash, skipping..." -ForegroundColor DarkYellow
            $results += [PSCustomObject]@{ Branch=$branchName; Status="SKIPPED" }
            continue
        } else {
            Write-Host "FAILED: commit" -ForegroundColor Red
            $results += [PSCustomObject]@{ Branch=$branchName; Status="FAILED"; Error="commit" }
            $failCount++; break
        }
    }

    # Step 4: Push
    git push myk1yt "HEAD:$branchName" --force --no-verify 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: push" -ForegroundColor Red
        $results += [PSCustomObject]@{ Branch=$branchName; Status="FAILED"; Error="push" }
        $failCount++; break
    }

    Write-Host "  SUCCESS: $branchName" -ForegroundColor Green
    $results += [PSCustomObject]@{ Branch=$branchName; Status="SUCCESS"; TempBranch=$tempBranch }
    $successCount++
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Magenta
Write-Host "FINAL SUMMARY: $successCount succeeded, $failCount failed" -ForegroundColor Magenta
Write-Host "==========================================" -ForegroundColor Magenta
$results | Format-Table -AutoSize

# Append to existing results
$existing = @()
if (Test-Path "$repoRoot/scripts/squash-results.json") {
    $existing = Get-Content "$repoRoot/scripts/squash-results.json" -Raw | ConvertFrom-Json
}
$allResults = @($existing) + @($results)
$allResults | ConvertTo-Json -Depth 3 | Out-File -FilePath "$repoRoot/scripts/squash-results.json" -Encoding utf8
Write-Host "Results saved to scripts/squash-results.json"

# Checkout main at the end
git checkout main 2>&1 | Out-Null
