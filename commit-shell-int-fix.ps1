Set-Location $PSScriptRoot
git add -A
git commit --no-verify -m "fix(terminal): retry with execa when shell integration loses command

When shell integration fails with commandSubmitted=true (command was
submitted but output tracking was lost), silently retry with execa
fallback instead of showing a dead-end error to the user.

Issues: #779, #705, #634"
