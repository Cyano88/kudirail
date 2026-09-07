param(
 [Parameter(Mandatory=$true)][ValidateSet('backup','verify')][string]$Mode,
 [Parameter(Mandatory=$true)][string]$Archive,
 [Parameter(Mandatory=$true)][string]$KeyFile
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
# DPAPI binds this key to the current Windows account. Independent key escrow is separate.
if (Test-Path -LiteralPath $KeyFile) {
 $key=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($KeyFile),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
 if ($Mode -ne 'backup') {throw 'Recovery key file is missing'}
 $key=New-Object byte[] 32
 $rng=[Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($key); $rng.Dispose()
 $protected=[Security.Cryptography.ProtectedData]::Protect($key,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 $stream=[IO.File]::Open($KeyFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try {$stream.Write($protected,0,$protected.Length)} finally {$stream.Dispose()}
}
try {
 $env:KUDI_BACKUP_KEY=[Convert]::ToBase64String($key).TrimEnd('=').Replace('+','-').Replace('/','_')
 & node --import tsx "$PSScriptRoot/manual-backup.ts" $Mode $Archive
 if ($LASTEXITCODE -ne 0) {throw 'Backup operation failed; inspect the sanitized stage result'}
} finally {
 [Array]::Clear($key,0,$key.Length)
 Remove-Item -LiteralPath Env:KUDI_BACKUP_KEY -ErrorAction SilentlyContinue
}
