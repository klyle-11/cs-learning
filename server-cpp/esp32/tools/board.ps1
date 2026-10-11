<#
.SYNOPSIS
Build, prepare the reader card, flash, or sign an OTA release from PowerShell.
.EXAMPLE
./server-cpp/esp32/tools/board.ps1 All -CardRoot E:/ -Port COM7 -Monitor
.EXAMPLE
./server-cpp/esp32/tools/board.ps1 Flash -Port COM7
.EXAMPLE
./server-cpp/esp32/tools/board.ps1 Release
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Position=0)]
    [ValidateSet('Build','Card','Flash','Release','All','PrepareState')][string]$Action = 'Build',
    [string]$CardRoot,
    [string]$Port,
    [switch]$Monitor,
    [string]$BuildDir = 'build',
    [string]$MsysRoot = 'C:/msys64'
)
$ErrorActionPreference = 'Stop'
$boardDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoDir = [IO.Path]::GetFullPath((Join-Path $boardDir '../..'))
$buildPath = if ([IO.Path]::IsPathRooted($BuildDir)) { $BuildDir } else { Join-Path $boardDir $BuildDir }
$buildPath = [IO.Path]::GetFullPath($buildPath)

function Run([string]$Program, [string[]]$Arguments) {
    Write-Host ('> ' + $Program + ' ' + ($Arguments -join ' '))
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Program" }
}
function CacheValue([string]$Name) {
    $match = [regex]::Match($script:cache, '(?m)^' + [regex]::Escape($Name) + ':[^=]+=(.*)\r?$')
    if (-not $match.Success) { throw "Missing $Name in CMakeCache.txt; configure/build once in an ESP-IDF terminal." }
    return $match.Groups[1].Value.Trim()
}

if ($Action -in @('Flash','All') -and $Port -notmatch '^COM[0-9]+$') { throw 'Specify the board port, e.g. -Port COM7.' }
if ($Monitor -and $Action -notin @('Flash','All')) { throw '-Monitor requires Flash or All.' }
if ($Action -in @('Card','All')) {
    if (-not $CardRoot -or -not (Test-Path -LiteralPath $CardRoot -PathType Container)) { throw 'Specify the mounted FAT32 card, e.g. -CardRoot E:/.' }
    $cardPath = (Resolve-Path -LiteralPath $CardRoot).Path.Replace('\','/')
    # Never guess a drive, copy onto the system disk, or format a card.
    if ($cardPath -notmatch '^[A-Za-z]:/$' -or $cardPath.Substring(0,2) -eq $env:SystemDrive) {
        throw '-CardRoot must be a mounted non-system drive root (e.g. E:/).'
    }
    $volume = Get-Volume -DriveLetter $cardPath.Substring(0,1)
    if ($volume.FileSystem -ne 'FAT32') { throw "Card is $($volume.FileSystem), not FAT32. No formatting was performed." }
    foreach ($module in @('marked','@highlightjs/cdn-assets','dompurify','pdfjs-dist','marginalia-engine','@fontsource/atkinson-hyperlegible','@fontsource/opendyslexic')) {
        if (-not (Test-Path -LiteralPath (Join-Path $repoDir "hub/node_modules/$module"))) { throw 'Reader dependencies are missing. Run npm install from hub first.' }
    }
}

$savedPath = $env:PATH; $savedIdf = $env:IDF_PATH; $savedPort = $env:ESPPORT
try {
    # Reuse IDF's configured build and its exact tool versions. This also works
    # with the Windows installer layout whose tools are outside ~/.espressif.
    # No set-target/fullclean/erase-flash: preserve menuconfig and board state.
    if ($Action -ne 'Card') {
        $descriptionFile = Join-Path $buildPath 'project_description.json'
        if (-not (Test-Path -LiteralPath $descriptionFile)) { throw 'No configured IDF build. Run idf.py set-target esp32s3 and idf.py build once in the ESP-IDF terminal.' }
        $description = Get-Content -LiteralPath $descriptionFile -Raw | ConvertFrom-Json
        if ([IO.Path]::GetFullPath($description.project_path) -ne $boardDir) { throw 'The selected build belongs to a different project.' }
        $script:cache = Get-Content -LiteralPath (Join-Path $buildPath 'CMakeCache.txt') -Raw
        $python = CacheValue 'PYTHON'
        $ninja = CacheValue 'CMAKE_MAKE_PROGRAM'
        $cmake = CacheValue 'CMAKE_COMMAND'
        $toolDirs = @((Split-Path $description.c_compiler), (Split-Path $python), (Split-Path $ninja), (Split-Path $cmake))
        if ($script:cache -match '(?m)^CCACHE_FOUND:[^=]+=(.+)') {
            $ccache = $Matches[1].Trim()
            if (Test-Path -LiteralPath $ccache) { $toolDirs += Split-Path $ccache }
        }
        $env:PATH = ($toolDirs -join ';') + ';' + $env:PATH
        $env:IDF_PATH = $description.idf_path
        Write-Host "IDF $($description.git_revision), chip $($description.target), build $buildPath"
        if ($Action -ne 'PrepareState' -and $PSCmdlet.ShouldProcess($buildPath, 'Build firmware with the configured ESP-IDF tools')) {
            Run $ninja @('-C', $buildPath)
            $firmwareId = (Get-FileHash -LiteralPath (Join-Path $buildPath 'hub.elf') -Algorithm SHA256).Hash.ToLowerInvariant()
            Write-Host "Firmware build ID: $firmwareId (compare with Settings on the running board)"
        }
    }
    if ($Action -eq 'PrepareState') {
        $rows = @(Get-Content -LiteralPath (Join-Path $boardDir 'partitions.csv') | Where-Object { $_ -match '^state\s*,' })
        if ($rows.Count -ne 1) { throw 'Expected exactly one state partition.' }
        $fields = $rows[0].Split(',') | ForEach-Object { $_.Trim() }
        $offset = $fields[3]; $size = $fields[4]
        $empty = Join-Path $buildPath 'empty-state-input'
        $image = Join-Path $buildPath 'empty-state.bin'
        if ($PSCmdlet.ShouldProcess($image, 'Prepare empty state image locally; no board writes')) {
            [IO.Directory]::CreateDirectory($empty) | Out-Null
            if (@(Get-ChildItem -LiteralPath $empty -Force).Count) { throw 'State image input must be empty.' }
            Run $python @((Join-Path $description.idf_path 'components/fatfs/wl_fatfsgen.py'), $empty,
                '--output_file', $image, '--partition_size', $size, '--sector_size', '4096')
            Write-Host "Empty state image: $image. For blank new hardware only. Writing it at $offset destroys existing CA/pairing state. Normal Flash/All never writes it."
        }
    }
    if ($Action -in @('Card','All')) {
        $env:PATH = (Join-Path $MsysRoot 'ucrt64/bin') + ';' + (Join-Path $MsysRoot 'usr/bin') + ';' + $env:PATH
        $make = Join-Path $MsysRoot 'usr/bin/make.exe'
        if (-not (Test-Path -LiteralPath $make)) { throw "MSYS2 make not found: $make" }
        if ($PSCmdlet.ShouldProcess("$cardPath/hub/www", 'Copy reader assets and generate gzip files (documents stay in place)')) {
            Run $make @('-C', (Join-Path $repoDir 'server-cpp'), 'card', "CARD=$cardPath")
            Write-Host 'Reader copied. Safely eject the card before removing it.'
        }
    }
    if ($Action -eq 'All' -and -not $WhatIfPreference) {
        Read-Host 'Safely eject the card, insert it into the powered-off board, connect USB, close any serial monitor, then press Enter' | Out-Null
    }
    if ($Action -in @('Flash','All')) {
        $env:ESPPORT = $Port
        if ($PSCmdlet.ShouldProcess($Port, 'Flash with the ESP-IDF generated flash target')) { Run $ninja @('-C', $buildPath, 'flash') }
        if ($Monitor -and $PSCmdlet.ShouldProcess($Port, 'Open serial monitor (Ctrl+] exits)')) {
            Run $python @((Join-Path $description.idf_path 'tools/idf_monitor.py'), '-p', $Port,
                '--toolchain-prefix', $description.monitor_toolprefix, (Join-Path $buildPath $description.app_elf))
        }
    }
    if ($Action -eq 'Release') {
        $bash = Join-Path $MsysRoot 'usr/bin/bash.exe'
        if (-not (Test-Path -LiteralPath $bash)) { throw "MSYS2 Bash not found: $bash" }
        $env:PATH = (Join-Path $MsysRoot 'usr/bin') + ';' + $env:PATH
        # Pass paths as separate arguments; no command-string interpolation.
        if ($PSCmdlet.ShouldProcess('build/release', 'Sign local OTA artifacts with the existing signing key')) {
            Run $bash @((Join-Path $PSScriptRoot 'release.sh').Replace('\','/'), $buildPath.Replace('\','/'))
            Write-Host 'Signed files prepared. Publication is a separate gh release create command; reader files are not part of firmware OTA.'
        }
    }
} finally {
    $env:PATH = $savedPath; $env:IDF_PATH = $savedIdf; $env:ESPPORT = $savedPort
}
