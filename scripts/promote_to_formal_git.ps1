param(
    [switch]$PreviewOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-RelativePath([string]$BasePath, [string]$FullPath) {
    return $FullPath.Substring($BasePath.Length).TrimStart('\')
}

function Get-FileFingerprint([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Test-SameFile([string]$Source, [string]$Target) {
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { return $false }
    $sourceInfo = Get-Item -LiteralPath $Source
    $targetInfo = Get-Item -LiteralPath $Target
    if ($sourceInfo.Length -ne $targetInfo.Length) { return $false }
    return (Get-FileFingerprint $Source) -eq (Get-FileFingerprint $Target)
}

function Write-Section([string]$Title) {
    Write-Host ''
    Write-Host ('=' * 64) -ForegroundColor DarkCyan
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ('=' * 64) -ForegroundColor DarkCyan
}

$betaRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$expectedBetaName = 'lvyoumap-universal-serverbeta'
if ((Split-Path $betaRoot -Leaf) -ne $expectedBetaName) {
    throw "安全检查失败：本工具只能从 $expectedBetaName 文件夹运行。当前路径：$betaRoot"
}

$formalRoot = if ($env:LVYOUMAP_FORMAL_DIR) {
    [System.IO.Path]::GetFullPath($env:LVYOUMAP_FORMAL_DIR)
} else {
    Join-Path (Split-Path $betaRoot -Parent) 'lvyoumap-universal-server'
}

if (-not (Test-Path -LiteralPath $formalRoot -PathType Container)) {
    throw "找不到正式 Git 文件夹：$formalRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $formalRoot '.git') -PathType Container)) {
    throw "目标不是 Git 仓库，已停止：$formalRoot"
}

$rootFiles = @(
    '.gitattributes',
    '.env.example',
    '.gitignore',
    'app.js',
    'authorize_server_access.bat',
    'china_geo.js',
    'china.json',
    'index.html',
    'package.json',
    'package-lock.json',
    'PROJECT_MAINTENANCE.md',
    'README.md',
    'run_gallery_batch.bat',
    'start_dev.bat',
    'start_universal_server.bat',
    'style.css',
    'sync_to_formal_git.bat',
    '数据维护总控.bat'
)
$sourceDirectories = @('assets', 'content', 'data', 'deploy', 'docs', 'scripts', 'server')
$excludedRelativePaths = @()
$excludedNames = @('Thumbs.db', 'desktop.ini', '.DS_Store')
$excludedExtensions = @('.tmp', '.bak', '.log', '.pyc')
$excludedBackupNamePattern = '(?i)\.bak(?:$|[._-])'

$sourceFiles = New-Object System.Collections.Generic.List[System.IO.FileInfo]
foreach ($name in $rootFiles) {
    $path = Join-Path $betaRoot $name
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $sourceFiles.Add((Get-Item -LiteralPath $path))
    }
}
foreach ($directory in $sourceDirectories) {
    $path = Join-Path $betaRoot $directory
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $path -File -Recurse) {
        $relative = Get-RelativePath $betaRoot $file.FullName
        if ($excludedRelativePaths -contains $relative) { continue }
        if ($relative -match '(?i)(^|\\)__pycache__(\\|$)') { continue }
        if ($excludedNames -contains $file.Name) { continue }
        if ($excludedExtensions -contains $file.Extension.ToLowerInvariant()) { continue }
        if ($file.Name -match $excludedBackupNamePattern) { continue }
        $sourceFiles.Add($file)
    }
}

# 全国报告与 build-info 作为最近一次完整验收基线。验收后的界面、文档或
# 小范围代码修复允许同步：正式服务器会重新构建，不能因为文件时间较新就
# 强迫用户再次运行耗时的总控 [4]。当前 beta 始终是唯一同步来源。
$nationalReportPath = Join-Path $betaRoot 'reports\core-attractions-national.json'
$buildInfoPath = Join-Path $betaRoot 'dist\build-info.json'
if (-not (Test-Path -LiteralPath $nationalReportPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $buildInfoPath -PathType Leaf)) {
    throw '尚未找到完整验收结果。请先在数据维护总控选择 [4]，通过后再同步。'
}
$nationalReport = Get-Content -LiteralPath $nationalReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([int]$nationalReport.missing -ne 0 -or [int]$nationalReport.review -ne 0 -or
    [int]$nationalReport.readyCount -ne [int]$nationalReport.baselineCount) {
    Write-Warning ("全国报告仍有非阻断项：missing={0}, review={1}, ready={2}/{3}。同步将继续，正式部署会重新构建；请以线上抽查为准。" -f
        $nationalReport.missing, $nationalReport.review, $nationalReport.readyCount, $nationalReport.baselineCount)
}
$buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json
$builtAt = [DateTimeOffset]::Parse([string]$buildInfo.builtAt).UtcDateTime
$newerSources = @($sourceFiles | Where-Object { $_.LastWriteTimeUtc -gt $builtAt.AddSeconds(2) } | Sort-Object LastWriteTimeUtc -Descending)
if ($newerSources.Count -gt 0) {
    $previewNames = @($newerSources | Select-Object -First 8 | ForEach-Object { Get-RelativePath $betaRoot $_.FullName })
    $suffix = if ($newerSources.Count -gt $previewNames.Count) { " 等 $($newerSources.Count) 个文件" } else { '' }
    Write-Warning ("最近完整验收后有新改动：{0}{1}。不再按时间戳阻断，将复制当前 beta；正式部署会重新构建。" -f ($previewNames -join '、'), $suffix)
}

# 对最容易因手工编辑损坏的运行入口做快速语法检查；不修改或重建任何源文件。
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($nodeCommand) {
    foreach ($relativeScript in @('app.js', 'server\index.js')) {
        $scriptPath = Join-Path $betaRoot $relativeScript
        if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { continue }
        & $nodeCommand.Source --check $scriptPath
        if ($LASTEXITCODE -ne 0) { throw "JavaScript 语法检查失败：$relativeScript" }
    }
} else {
    Write-Warning '未找到 node.exe，已跳过 JavaScript 快速语法检查。'
}

$oversized = $sourceFiles | Where-Object { $_.Length -ge 95MB }
if ($oversized) {
    $names = ($oversized | ForEach-Object { Get-RelativePath $betaRoot $_.FullName }) -join '、'
    throw "发现接近或超过 GitHub 单文件限制的文件，已停止：$names"
}

$changes = New-Object System.Collections.Generic.List[object]
foreach ($source in ($sourceFiles | Sort-Object FullName -Unique)) {
    $relative = Get-RelativePath $betaRoot $source.FullName
    $target = Join-Path $formalRoot $relative
    if (Test-SameFile $source.FullName $target) { continue }
    $state = if (Test-Path -LiteralPath $target -PathType Leaf) { '更新' } else { '新增' }
    $changes.Add([pscustomobject]@{
        State = $state
        RelativePath = $relative
        Source = $source.FullName
        Target = $target
        Bytes = $source.Length
    })
}

Write-Section '中国旅游地图：beta → 正式 Git 安全同步'
Write-Host "来源：$betaRoot"
Write-Host "目标：$formalRoot"
Write-Host '排除：.runtime、dist、reports、node_modules、.env、日志和临时文件'

if ($changes.Count -eq 0) {
    Write-Host ''
    Write-Host '没有需要同步的文件，正式 Git 已与 beta 白名单内容一致。' -ForegroundColor Green
    exit 0
}

$totalBytes = ($changes | Measure-Object -Property Bytes -Sum).Sum
Write-Host ''
Write-Host ("发现 {0} 个文件需要同步，共 {1:N2} MB：" -f $changes.Count, ($totalBytes / 1MB)) -ForegroundColor Yellow
foreach ($change in $changes) {
    Write-Host ("[{0}] {1}" -f $change.State, $change.RelativePath)
}

if ($PreviewOnly) {
    Write-Host ''
    Write-Host '当前为预览模式，没有复制任何文件。' -ForegroundColor Yellow
    exit 0
}

$dirtyOutput = & git.exe -C $formalRoot status --porcelain 2>$null
if ($LASTEXITCODE -ne 0) { throw '无法读取正式 Git 仓库状态。' }
if ($dirtyOutput) {
    Write-Host ''
    Write-Host '注意：正式 Git 当前已有未提交改动。同步工具会先备份即将覆盖的文件。' -ForegroundColor Yellow
}

Write-Host ''
$approval = Read-Host '确认把以上文件复制到正式 Git？请输入 Y，其他键取消'
if ($approval.Trim().ToUpperInvariant() -ne 'Y') {
    Write-Host '已取消，没有修改正式 Git。' -ForegroundColor Yellow
    exit 0
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $betaRoot ".runtime\promotion-backups\$timestamp"
$logRoot = Join-Path $betaRoot '.runtime\promotion-logs'
$createdTargets = New-Object System.Collections.Generic.List[string]
$backedUpTargets = New-Object System.Collections.Generic.List[object]

try {
    foreach ($change in $changes) {
        if (Test-Path -LiteralPath $change.Target -PathType Leaf) {
            $backupPath = Join-Path $backupRoot $change.RelativePath
            New-Item -ItemType Directory -Path (Split-Path $backupPath -Parent) -Force | Out-Null
            Copy-Item -LiteralPath $change.Target -Destination $backupPath -Force
            $backedUpTargets.Add([pscustomobject]@{ Target = $change.Target; Backup = $backupPath })
        } else {
            $createdTargets.Add($change.Target)
        }
        New-Item -ItemType Directory -Path (Split-Path $change.Target -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $change.Source -Destination $change.Target -Force
        if (-not (Test-SameFile $change.Source $change.Target)) {
            throw "复制后校验失败：$($change.RelativePath)"
        }
    }

    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $manifest = [pscustomobject]@{
        timestamp = (Get-Date).ToString('o')
        source = $betaRoot
        target = $formalRoot
        count = $changes.Count
        backup = $backupRoot
        files = @($changes | ForEach-Object { [pscustomobject]@{ state = $_.State; path = $_.RelativePath; bytes = $_.Bytes } })
    }
    $manifestPath = Join-Path $logRoot "$timestamp.json"
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    Write-Section '同步完成'
    Write-Host ("已复制并校验 {0} 个文件。" -f $changes.Count) -ForegroundColor Green
    Write-Host "覆盖前备份：$backupRoot"
    Write-Host "同步记录：$manifestPath"
    Write-Host '下一步：打开 GitHub Desktop，检查改动后自行提交和推送。' -ForegroundColor Cyan
} catch {
    Write-Host ''
    Write-Host '同步失败，正在自动回滚……' -ForegroundColor Red
    foreach ($target in $createdTargets) {
        if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
    }
    foreach ($entry in $backedUpTargets) {
        New-Item -ItemType Directory -Path (Split-Path $entry.Target -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $entry.Backup -Destination $entry.Target -Force
    }
    throw
}
