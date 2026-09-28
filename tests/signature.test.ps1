$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../scripts/verify-signature.ps1"

Assert-ReleaseSignature ([pscustomobject]@{ Status='Valid'; SignerCertificate=[pscustomobject]@{ Subject='CN=BMD PAT LLC, O=BMD PAT LLC, C=US' } })
$refused = 0
foreach ($signature in @(
    [pscustomobject]@{ Status='NotSigned'; SignerCertificate=$null },
    [pscustomobject]@{ Status='HashMismatch'; SignerCertificate=[pscustomobject]@{ Subject='CN=BMD PAT LLC' } },
    [pscustomobject]@{ Status='Valid'; SignerCertificate=[pscustomobject]@{ Subject='CN=Another Publisher' } },
    [pscustomobject]@{ Status='Valid'; SignerCertificate=[pscustomobject]@{ Subject='CN=BMD PAT LLC Impostor' } },
    [pscustomobject]@{ Status='Valid'; SignerCertificate=$null }
)) {
    try { Assert-ReleaseSignature $signature } catch { $refused++ }
}
if ($refused -ne 5) { throw "Expected five signature refusals, got $refused" }
Write-Output 'Signature policy: 6 cases passed'
