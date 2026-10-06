# Renames each subfolder of the folder this is run in to the name of the book
# inside it: its .epub, or its .pdf if it has no .epub.
#
#   cd "D:\Books\Some Parent Folder"
#   powershell -ExecutionPolicy Bypass -File C:\Users\khali\csprojects\cs-learning\rename-book-folders.ps1          (shows what it would do)
#   powershell -ExecutionPolicy Bypass -File C:\Users\khali\csprojects\cs-learning\rename-book-folders.ps1 -Apply   (does it)
#
# Only the folders directly inside the current folder are looked at, and only
# the books directly inside each of those. The current folder itself is never
# renamed. A folder is left alone, with a line saying why, when it has no
# book, more than one .epub (or, with no .epub, more than one .pdf), already
# has the book's name, or another folder already has that name.
param([switch]$Apply)

$renamed = 0; $skipped = 0
foreach ($folder in Get-ChildItem -LiteralPath (Get-Location) -Directory) {
    $books = @(Get-ChildItem -LiteralPath $folder.FullName -File | Where-Object { $_.Extension -ieq '.epub' })
    if (-not $books) { $books = @(Get-ChildItem -LiteralPath $folder.FullName -File | Where-Object { $_.Extension -ieq '.pdf' }) }

    if ($books.Count -eq 0) { Write-Host "skip  $($folder.Name): no .epub or .pdf in it"; $skipped++; continue }
    if ($books.Count -gt 1) { Write-Host "skip  $($folder.Name): $($books.Count) books in it, cannot tell which names it"; $skipped++; continue }

    # A folder's name may not end in a dot or a space on Windows.
    $name = $books[0].BaseName.TrimEnd('.', ' ')
    if (-not $name) { Write-Host "skip  $($folder.Name): the book has no usable name"; $skipped++; continue }
    if ($name -ceq $folder.Name) { continue }   # already named for its book

    $target = Join-Path $folder.Parent.FullName $name
    # Another folder (or file) has the name. A change of letter case only is the same folder, and is allowed.
    if ((Test-Path -LiteralPath $target) -and ($name -ine $folder.Name)) { Write-Host "skip  $($folder.Name): '$name' already exists here"; $skipped++; continue }

    if ($Apply) {
        try {
            if ($name -ieq $folder.Name) {
                # Windows will not rename to the same name in another case in one step.
                $temp = "$($folder.Name).renaming-$PID"
                Rename-Item -LiteralPath $folder.FullName -NewName $temp -ErrorAction Stop
                Rename-Item -LiteralPath (Join-Path $folder.Parent.FullName $temp) -NewName $name -ErrorAction Stop
            } else {
                Rename-Item -LiteralPath $folder.FullName -NewName $name -ErrorAction Stop
            }
            Write-Host "done  $($folder.Name)  ->  $name"; $renamed++
        } catch { Write-Host "FAIL  $($folder.Name): $($_.Exception.Message)"; $skipped++ }
    } else {
        Write-Host "would $($folder.Name)  ->  $name"; $renamed++
    }
}
if ($Apply) { Write-Host "`n$renamed renamed, $skipped left alone." }
else { Write-Host "`n$renamed would be renamed, $skipped left alone. Nothing was changed: run again with -Apply to do it." }
