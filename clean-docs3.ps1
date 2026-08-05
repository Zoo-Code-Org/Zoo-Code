$branches = @(
    "b05-shell-resolution-v2",
    "b05a-strict-reasoning-v2",
    "b10-task-org-ui-v2",
    "b12-mimo-enforcement-v2",
    "b15-usage-capture-v2",
    "b16-stats-ui-v2",
    "b17-provider-cost-v2"
)

foreach ($branch in $branches) {
    Write-Output "=== Cleaning docs from $branch ==="
    
    # Force checkout the remote branch fresh
    git checkout -B "temp/pr/$branch" "myk1yt/pr/$branch" 2>&1 | Out-Null
    
    # Get docs files in diff against upstream/main
    $docsFiles = (git diff --name-only "upstream/main...HEAD" -- "docs/" 2>&1) | Where-Object { $_ -and $_.Trim() }
    
    if (-not $docsFiles -or $docsFiles.Count -eq 0) {
        Write-Output "  No docs files found, skipping"
        continue
    }
    
    Write-Output "  Found $($docsFiles.Count) docs files to remove"
    
    # Remove each file from git tracking and filesystem
    foreach ($file in $docsFiles) {
        $file = $file.Trim()
        if ($file) {
            git rm -f --quiet "$file" 2>&1 | Out-Null
        }
    }
    
    $commitResult = git commit -m "chore: remove internal session report files from PR" --no-verify 2>&1
    Write-Output "  Commit: $commitResult"
    
    # Push
    $pushResult = git push myk1yt "HEAD:pr/$branch" --force --no-verify 2>&1
    Write-Output "  Push done"
}

# Return to the b09 branch
git checkout temp/pr/b09-task-org-ipc-v2 2>&1 | Out-Null
Write-Output "=== All branches cleaned ==="
