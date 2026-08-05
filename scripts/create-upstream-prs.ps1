# Create 17 PRs on Zoo-Code-Org/Zoo-Code from myk1yt fork
# All PRs target base=main (fork-based strategy)

$ErrorActionPreference = "Continue"
$repoRoot = "c:/Users/k1yt/OneDrive/Projects/ZooCode"
Set-Location $repoRoot

# Load PR metadata from myk1yt
$prMeta = Get-Content "$repoRoot/scripts/pr-metadata.json" -Raw | ConvertFrom-Json

$results = @()
$successCount = 0
$failCount = 0

foreach ($pr in $prMeta) {
    $headBranch = "myk1yt:$($pr.head)"
    $baseBranch = "main"
    $title = $pr.title
    $body = $pr.body

    Write-Host ""
    Write-Host "Creating PR: $title" -ForegroundColor Cyan
    Write-Host "  head: $headBranch -> base: $baseBranch" -ForegroundColor Gray

    # Create PR via gh CLI
    $result = gh pr create `
        --repo "Zoo-Code-Org/Zoo-Code" `
        --title $title `
        --body $body `
        --head $headBranch `
        --base $baseBranch `
        --no-maintainer-edit 2>&1

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  CREATED: $result" -ForegroundColor Green
        $results += [PSCustomObject]@{ Number=$pr.number; Branch=$pr.head; Status="CREATED"; Url=$result }
        $successCount++
    } else {
        Write-Host "  FAILED: $result" -ForegroundColor Red
        $results += [PSCustomObject]@{ Number=$pr.number; Branch=$pr.head; Status="FAILED"; Error=$result.ToString() }
        $failCount++
    }
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Magenta
Write-Host "PR CREATION SUMMARY: $successCount created, $failCount failed" -ForegroundColor Magenta
Write-Host "==========================================" -ForegroundColor Magenta
$results | Format-Table -AutoSize

$results | ConvertTo-Json -Depth 3 | Out-File -FilePath "$repoRoot/scripts/pr-creation-results.json" -Encoding utf8
Write-Host "Results saved to scripts/pr-creation-results.json"
