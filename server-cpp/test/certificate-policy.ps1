# Uses an in-memory custom trust anchor. Never installs certificates.
param([string]$Root, [string]$Issuer, [string]$Certificate, [string]$Purpose, [switch]$ExpectedAllowed)
$ErrorActionPreference = 'Stop'
$chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
try {
    $chain.ChainPolicy.TrustMode = [Security.Cryptography.X509Certificates.X509ChainTrustMode]::CustomRootTrust
    [void]$chain.ChainPolicy.CustomTrustStore.Add([Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem([IO.File]::ReadAllText($Root)))
    [void]$chain.ChainPolicy.ExtraStore.Add([Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem([IO.File]::ReadAllText($Issuer)))
    $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    $chain.ChainPolicy.DisableCertificateDownloads = $true
    [void]$chain.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new($Purpose))
    $leaf = [Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem([IO.File]::ReadAllText($Certificate))
    $allowed = $chain.Build($leaf)
    if ($ExpectedAllowed) {
        if (-not $allowed) { throw ('Unexpected rejection: ' + ($chain.ChainStatus.Status -join ',')) }
        Write-Output 'Accepted legacy application policy in custom trust chain (no certificate installed)'
        return
    }
    if ($allowed) { throw 'Unexpectedly accepted restricted application policy' }
    if (-not ($chain.ChainStatus.Status -contains [Security.Cryptography.X509Certificates.X509ChainStatusFlags]::NotValidForUsage)) {
        throw ('Rejected for another reason: ' + ($chain.ChainStatus.Status -join ','))
    }
} finally { $chain.Dispose() }
