param([Parameter(Mandatory=$true)][string]$AppDir)

$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'AutoGit.lnk'

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $AppDir 'AutoGit.vbs'
$lnk.WorkingDirectory = $AppDir
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -and (Test-Path $node.Source)) { $lnk.IconLocation = "$($node.Source),0" }
$lnk.Description = 'AutoGit 실행기 (터미널 TUI)'
$lnk.Save()

Write-Host ''
Write-Host '바탕화면에 AutoGit 바로가기를 만들었습니다.' -ForegroundColor Green
Write-Host '이제 바탕화면의 AutoGit 아이콘을 더블클릭하면 터미널에서 실행됩니다.'
Write-Host '바로가기 아이콘을 마우스 오른쪽 클릭 > 속성 에서 대상에 Git 저장소 경로를 인수로 넣을 수 있습니다.'
