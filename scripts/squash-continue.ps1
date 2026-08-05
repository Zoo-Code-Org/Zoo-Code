# Continuation: squash remaining 14 branches (b08 already done)
# Phase 1 remaining + Phase 2-4

$repoRoot = "c:/Users/k1yt/OneDrive/Projects/ZooCode"
Set-Location $repoRoot

$prs = @(
    # Phase 1 remaining (b04, b01, b08 already done)
    @{ name="pr/b13-usage-store-v2";        base="upstream/main";                   message="feat: add usage statistics event store and contracts";                   source="myk1yt/pr/b13-usage-store-v2" }
    @{ name="pr/b05a-strict-reasoning-v2";  base="upstream/main";                   message="feat: add provider strict reasoning settings and base request shaping"; source="myk1yt/pr/b05a-strict-reasoning-v2" }

    # Phase 2
    @{ name="pr/b05-shell-resolution-v2";   base="temp/pr/b04-shell-contracts-v2";   message="feat: add shell resolver, invocation adapter, and profile resolution";     source="myk1yt/pr/b05-shell-resolution-v2" }
    @{ name="pr/b02-error-runtime-v2";      base="temp/pr/b01-error-contracts-v2";   message="feat: add error interception runtime and task error state";                source="myk1yt/pr/b02-error-runtime-v2" }
    @{ name="pr/b09-task-org-ipc-v2";       base="temp/pr/b08-task-persistence-v2";  message="feat: add task organization message handler and webview IPC";              source="myk1yt/pr/b09-task-org-ipc-v2" }
    @{ name="pr/b14-usage-aggregation-v2";  base="temp/pr/b13-usage-store-v2";      message="feat: add usage aggregation, cost recalculation, and service";             source="myk1yt/pr/b14-usage-aggregation-v2" }
    @{ name="pr/b12-mimo-enforcement-v2";   base="temp/pr/b05a-strict-reasoning-v2"; message="fix: add MiMo parallel tool call policy, ghost quarantine, and retention"; source="myk1yt/pr/b12-mimo-enforcement-v2" }
    @{ name="pr/b17-provider-cost-v2";      base="temp/pr/b05a-strict-reasoning-v2"; message="feat: add provider cost normalization and usage field handling";          source="myk1yt/pr/b17-provider-cost-v2" }

    # Phase 3
    @{ name="pr/b06-terminal-lifecycle-v2"; base="temp/pr/b05-shell-resolution-v2";  message="feat: add terminal lifecycle, command scheduler, registry, and trace";     source="myk1yt/pr/b06-terminal-lifecycle-v2" }
    @{ name="pr/b03-error-integration-v2";  base="temp/pr/b02-error-runtime-v2";     message="feat: integrate error interception into assistant message presentation";  source="myk1yt/pr/b03-error-integration-v2" }
    @{ name="pr/b10-task-org-ui-v2";        base="temp/pr/b09-task-org-ipc-v2";      message="feat: add task organization DnD UI, dialogs, and optimistic reconciliation"; source="myk1yt/pr/b10-task-org-ui-v2" }
    @{ name="pr/b15-usage-capture-v2";      base="temp/pr/b14-usage-aggregation-v2"; message="feat: add exactly-once usage capture from task API completion";          source="myk1yt/pr/b15-usage-capture-v2" }

    # Phase 4
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
    Write-Host "  Base:   $baseBranch" -ForegroundColor Gray
    Write-Host "  Source: $sourceBranch" -ForegroundColor Gray
    Write-Host "==========================================" -ForegroundColor Cyan

    # Step 1: Create temp branch from base
    Write-Host "[1/4] checkout -B $tempBranch $baseBranch" -ForegroundColor Yellow
    git checkout -B $tempBranch $baseBranch 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: checkout" -ForegroundColor Red
        $results += [PSCustomObject]@{ Branch=$branchName; Status="FAILED"; Error="checkout" }
        $failCount++; break
    }

    # Step 2: Squash merge
    Write-Host "[2/4] merge --squash $sourceBranch" -ForegroundColor Yellow
    git merge --squash $sourceBranch 2>&1
    if ($LASTEXITCODE -ne 0) {
        # Try resolving eslint-suppressions.json conflict
        Write-Host "  Merge conflict detected, resolving eslint-suppressions.json..." -ForegroundColor DarkYellow
        git checkout --theirs src/eslint-suppressions.json 2>&1 | Out-Null
        git add src/eslint-suppressions.json 2>&1 | Out-Null
    }

    # Step 3: Commit
    Write-Host "[3/4] commit" -ForegroundColor Yellow
    git commit -m $commitMessage --no-verify 2>&1
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
    Write-Host "[4/4] push myk1yt:$branchName" -ForegroundColor Yellow
    git push myk1yt "HEAD:$branchName" --force --no-verify 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: push" -ForegroundColor Red
        $results += [PSCustomObject]@{ Branch=$branchName; Status="FAILED"; Error="push" }
        $failCount++; break
    }

    Write-Host "SUCCESS" -ForegroundColor Green
    $results += [PSCustomObject]@{ Branch=$branchName; Status="SUCCESS"; TempBranch=$tempBranch }
    $successCount++
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Magenta
Write-Host "CONTINUATION SUMMARY: $successCount succeeded, $failCount failed" -ForegroundColor Magenta
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
