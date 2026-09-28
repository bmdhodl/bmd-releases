param([string]$Installer)
$ErrorActionPreference = 'Stop'

function Assert-ReleaseSignature {
    param($Signature)
    if (-not $Signature -or [string]$Signature.Status -ne 'Valid') {
        throw 'Installer does not have a valid Authenticode signature'
    }
    if (-not $Signature.SignerCertificate -or
        $Signature.SignerCertificate.Subject -notmatch '(^|,\s*)(CN|O)=BMD PAT LLC(,|$)') {
        throw 'Installer signature does not identify BMD PAT LLC'
    }
}

if ($Installer) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Installer
    Assert-ReleaseSignature $signature
    [pscustomobject]@{ Path=$Installer; Status=[string]$signature.Status;
        Publisher=$signature.SignerCertificate.Subject;
        Thumbprint=$signature.SignerCertificate.Thumbprint } | ConvertTo-Json
}
