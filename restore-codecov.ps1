$branches = @(
    @{branch="temp/pr/b01-error-contracts-v2"; remote="pr/b01-error-contracts-v2"},
    @{branch="temp/pr/b13-usage-store-v2"; remote="pr/b13-usage-store-v2"},
    @{branch="temp/pr/b05-shell-resolution-v2"; remote="pr/b05-shell-resolution-v2"},
    @{branch="temp/pr/b09-task-org-ipc-v2"; remote="pr/b09-task-org-ipc-v2"},
    @{branch="temp/pr/b03-error-integration-v2"; remote="pr/b03-error-integration-v2"},
    @{branch="temp/pr/b10-task-org-ui-v2"; remote="pr/b10-task-org-ui-v2"},
    @{branch="temp/pr/b12-mimo-enforcement-v2"; remote="pr/b12-mimo-enforcement-v2"},
    @{branch="temp/pr/b17-provider-cost-v2"; remote="pr/b17-provider-cost-v2"},
    @{branch="temp/pr/b16-stats-ui-v2"; remote="pr/b16-stats-ui-v2"}
)

foreach ($b in $branches) {
    $branch = $b.branch
    $remote = $b.remote
    Write-Host "=== Processing $branch ==="
    
    # Checkout the branch
    git checkout $branch 2>&1 | Out-Null
    
    # Restore codecov.yml from upstream/main
    git checkout upstream/main -- codecov.yml 2>&1
    
    # Check if there are changes
    $hasChanges = git diff --cached --name-only 2>&1
    if ($hasChanges) {
        git commit --no-verify -m "fix: restore codecov.yml to upstream 80% patch coverage threshold" 2>&1 | Out-Null
        Write-Host "  Committed codecov.yml restoration"
    } else {
        # Check if codecov.yml differs from upstream
        $diff = git diff HEAD upstream/main -- codecov.yml 2>&1
        if ($diff) {
            git checkout upstream/main -- codecov.yml 2>&1
            git add codecov.yml
            git commit --no-verify -m "fix: restore codecov.yml to upstream 80% patch coverage threshold" 2>&1 | Out-Null
            Write-Host "  Committed codecov.yml restoration (uncached)"
        } else {
            Write-Host "  No changes needed"
            continue
        }
    }
    
    # Push
    git push myk1yt HEAD:$remote --force --no-verify 2>&1 | Out-Null
    Write-Host "  Pushed to $remote"
}

Write-Host "`n=== Done ==="
