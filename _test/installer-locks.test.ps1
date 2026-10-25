param([string]$DeliveredInstaller = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$testOutput = Join-Path $projectRoot 'build\installer-regression'
New-Item -ItemType Directory -Path $testOutput -Force | Out-Null
$testExecutable = Join-Path $testOutput 'InstallerRegression.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /main:InstallerRegression /optimize+ "/out:$testExecutable" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll (Join-Path $projectRoot 'installer\Setup.cs') (Join-Path $PSScriptRoot 'installer-locks.test.cs')
if ($LASTEXITCODE -ne 0) { throw 'Installer regression compilation failed.' }
if ($DeliveredInstaller) { & $testExecutable $DeliveredInstaller } else { & $testExecutable }
if ($LASTEXITCODE -ne 0) { throw 'Installer regression failed.' }
