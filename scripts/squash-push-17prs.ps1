# Squash and push 17 stacked PR branches to myk1yt/Zoo-Code (fork)
# Processes branches in dependency order (Phase 1 -> 2 -> 3 -> 4)

$repoRoot = "c:/Users/k1yt/OneDrive/Projects/ZooCode"
Set-Location $repoRoot

# Ensure we're on main and up-to-date
git checkout main 2>&1 | Out-Null
git fetch upstream main 2>&1 | Out-Null
git reset --hard upstream/main 2>&1 | Out-Null

$prs = @(
    # Phase 1: Root PRs (base = upstream/main)
    @{ name="pr/b04-shell-contracts-v2";   base="upstream/main";                   message="feat: add unified shell resolution contracts and settings UI";           source="myk1yt/pr/b04-shell-contracts-v2" }
    @{ name="pr/b01-error-contracts-v2";    base="upstream/main";                   message="feat: add error interception classification contracts";                  source="myk1yt/pr/b01-error-contracts-v2" }
    @{ name="pr/b08-task-persistence-v2";   base="upstream/main";                   message="feat: add task organization persistence store and schema";              source="myk1yt/pr/b08-task-persistence-v2" }
    @{ name="pr/b13-usage-store-v2";        base="upstream/main";                   message="feat: add usage statistics event store and contracts";                   source="myk1yt/pr/b13-usage-store-v2" }
    @{ name="pr/b05a-strict-reasoning-v2";  base="upstream/main";                   message="feat: add provider strict reasoning settings and base request shaping"; source="myk1yt/pr/b05a-strict-reasoning-v2" }

    # Phase 2: Second-level PRs
    @{ name="pr/b05-shell-resolution-v2";   base="temp/pr/b04-shell-contracts-v2";   message="feat: add shell resolver, invocation adapter, and profile resolution";     source="myk1yt/pr/b05-shell-resolution-v2" }
    @{ name="pr/b02-error-runtime-v2";      base="temp/pr/b01-error-contracts-v2";   message="feat: add error interception runtime and task error state";                source="myk1yt/pr/b02-error-runtime-v2" }
    @{ name="pr/b09-task-org-ipc-v2";       base="temp/pr/b08-task-persistence-v2";  message="feat: add task organization message handler and webview IPC";              source="myk1yt/pr/b09-task-org-ipc-v2" }
    @{ name="pr/b14-usage-aggregation-v2";  base="temp/pr/b13-usage-store-v2";      message="feat: add usage aggregation, cost recalculation, and service";             source="myk1yt/pr/b14-usage-aggregation-v2" }
    @{ name="pr/b12-mimo-enforcement-v2";   base="temp/pr/b05a-strict-reasoning-v2"; message="fix: add MiMo parallel tool call policy, ghost quarantine, and retention"; source="myk1yt/pr/b12-mimo-enforcement-v2" }
    @{ name="pr/b17-provider-cost-v2";      base="temp/pr/b05a-strict-reasoning-v2"; message="feat: add provider cost normalization and usage field handling";          source="myk1yt/pr/b17-provider-cost-v2" }

    # Phase 3: Third-level PRs
    @{ name="pr/b06-terminal-lifecycle-v2"; base="temp/pr/b05-shell-resolution-v2";  message="feat: add terminal lifecycle, command scheduler, registry, and trace";     source="myk1yt/pr/b06-terminal-lifecycle-v2" }
    @{ name="pr/b03-error-integration-v2";  base="temp/pr/b02-error-runtime-v2";     message="feat: integrate error interception into assistant message presentation";  source="myk1yt/pr/b03-error-integration-v2" }
    @{ name="pr/b10-task-org-ui-v2";        base="temp/pr/b09-task-org-ipc-v2";      message="feat: add task organization DnD UI, dialogs, and optimistic reconciliation"; source="myk1yt/pr/b10-task-org-ui-v2" }
    @{ name="pr/b15-usage-capture-v2";      base="temp/pr/b14-usage-aggregation-v2"; message="feat: add exactly-once usage capture from task API completion";          source="myk1yt/pr/b15-usage-capture-v2" }

    # Phase 4: Fourth-level PRs
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
    Write-Host "  Msg:    $commitMessage" -ForegroundColor Gray
    Write-Host "==========================================" -ForegroundColor Cyan

    # Step 1: Create temp branch from base
    Write-Host "[1/5] Creating temp branch $tempBranch from $baseBranch..." -ForegroundColor Yellow
    git checkout -B $tempBranch $baseBranch 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: checkout -B $tempBranch $baseBranch (exit $LASTEXITCODE)" -ForegroundColor Red
        $results += [PSCustomObject]@{ Branch=$branchName; Status="FAILED"; Error="checkout failed" }
        $failCount++
        break
    }

    # Step 2: Squash merge from source
    Write-Host "[2/5] Squash merging $sourceBranch..." -ForegroundColor Yellow
    git merge --squash $sourceBranch 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: merge --squash $sourceBranch (exit $LASTEXITCODE)" -ForegroundColor Red
        $results += [PSCustomObject]@{ Branch=$branchName; Status="FAILED"; Error="squash merge failed" }
        $failCount++
        break
    }

    # Step 3: Commit
    Write-Host "[3/5] Committing squash..." -ForegroundColor Yellow
    git commit -m $commitMessage --no-verify 2>&1
    if ($LASTEXITCODE -ne 0) {
        $statusOutput = git status --porcelain 2>&1
        if ([string]::IsNullOrWhiteSpace($statusOutput)) {
            Write-Host "  Nothing to commit (empty squash), skipping push..." -ForegroundColor DarkYellow
            $results += [PSCustomObject]@{ Branch=$branchName; Status="SKIPPED"; TempBranch=$tempBranch }
            continue
        } else {
            Write-Host "FAILED: commit (exit $LASTEXITCODE)" -ForegroundColor Red
            $results += [PSCustomObject]@{ Branch=$branchName; Status="FAILED"; Error="commit failed" }
            $failCount++
            break
        }
    }

    # Step 4: Push to myk1yt (fork)
    Write-Host "[4/5] Pushing to myk1yt:$branchName..." -ForegroundColor Yellow
    git push myk1yt "HEAD:$branchName" --force --no-verify 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: push to myk1yt:$branchName (exit $LASTEXITCODE)" -ForegroundColor Red
        $results += [PSCustomObject]@{ Branch=$branchName; Status="FAILED"; Error="push failed" }
        $failCount++
        break
    }

    # Step 5: Record success
    Write-Host "[5/5] Done. Temp branch $tempBranch kept for dependents." -ForegroundColor Green
    $results += [PSCustomObject]@{ Branch=$branchName; Status="SUCCESS"; TempBranch=$tempBranch }
    $successCount++
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Magenta
Write-Host "SUMMARY: $successCount succeeded, $failCount failed" -ForegroundColor Magenta
Write-Host "==========================================" -ForegroundColor Magenta
$results | Format-Table -AutoSize

$results | ConvertTo-Json -Depth 3 | Out-File -FilePath "$repoRoot/scripts/squash-results.json" -Encoding utf8
Write-Host "Results saved to scripts/squash-results.json"
