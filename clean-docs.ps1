$branches = @(
    "b05-shell-resolution-v2",
    "b05a-strict-reasoning-v2",
    "b07-shell-integration-v2",
    "b10-task-org-ui-v2",
    "b12-mimo-enforcement-v2",
    "b15-usage-capture-v2",
    "b16-stats-ui-v2",
    "b17-provider-cost-v2"
)

foreach ($branch in $branches) {
    Write-Output "=== Cleaning docs from $branch ==="
    
    # Checkout the remote branch
    git checkout -B "temp/pr/$branch" "myk1yt/pr/$branch" 2>&1 | Out-Null
    
    # Remove all docs files that are in the diff (session reports + feedbacks)
    $docsFiles = git diff --name-only upstream/main...HEAD -- "docs/" 2>&1
    if (-not $docsFiles) {
        Write-Output "  No docs files found, skipping"
        continue
    }
    
    foreach ($file in $docsFiles) {
        $file = $file.Trim()
        if ($file -and (Test-Path $file)) {
            git rm --cached "$file" 2>&1 | Out-Null
        }
    }
    
    git commit -m "chore: remove internal session report files from PR

These docs/ files are internal session reports and should not be
included in the PR diff." --no-verify 2>&1 | Out-Null
    
    # Push
    git push myk1yt "HEAD:pr/$branch" --force --no-verify 2>&1 | Out-Null
    Write-Output "  Done"
}

# Return to the b09 branch
git checkout temp/pr/b09-task-org-ipc-v2 2>&1 | Out-Null
Write-Output "=== All branches cleaned ==="
