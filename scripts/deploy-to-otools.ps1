# 把插件同步到 otools 仓库的 plugins 目录（本地试跑用）
# 用法：pwsh -File scripts/deploy-to-otools.ps1 [-OtoolsRoot "D:\Repos\xyito\otools\otools"]
#
# 只同步宿主真正需要的东西：清单、图标、构建产物 dist/。
# upstream/、shell/、scripts/、node_modules 都留在本仓库，不进插件目录。
param(
  [string]$OtoolsRoot = "D:\Repos\xyito\otools\otools"
)

$ErrorActionPreference = "Stop"
$pluginRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $OtoolsRoot "plugins\otools-video"

if (-not (Test-Path (Join-Path $OtoolsRoot "vendor\otools-plugin-sdk\src\index.ts"))) {
  Write-Error "未找到 otools 仓库：$OtoolsRoot（可用 -OtoolsRoot 指定其它路径）"
}

if (-not (Test-Path (Join-Path $pluginRoot "dist\index.html"))) {
  Write-Error "没有 dist/，先跑 node scripts/build.mjs"
}

New-Item -ItemType Directory -Force -Path $target | Out-Null

$ship = @(
  "plugin.json",
  "logo.svg",
  "dist"
)

foreach ($item in $ship) {
  $from = Join-Path $pluginRoot $item
  if (-not (Test-Path $from)) { continue }
  if (Test-Path (Join-Path $target $item)) {
    Remove-Item -LiteralPath (Join-Path $target $item) -Recurse -Force
  }
  Copy-Item -LiteralPath $from -Destination $target -Recurse -Force
}

Write-Host "已同步到 $target"
Write-Host "在 otools 里重载/重启应用即可看到「视频剪辑」插件。"
