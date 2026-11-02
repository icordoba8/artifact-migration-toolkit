# Owner instruction 2 (HUMAN_ATTESTED, verbatim), received 2026-10-31T21:56:56Z
```
VAULT_COPY_DESTINATION: choose it yourself; do not ask me. Pick a location outside the WSL virtual disk, preferring, in this order:
1. A Windows drive on a different physical disk than the WSL VHDX.
2. A cloud-synced folder under /mnt/c/Users/*, such as OneDrive.
3. Otherwise, /mnt/c/amt-evidence-vault-copy/, flagged as the risk SAME_PHYSICAL_DISK.
Record which location you chose and why.

OWNER STEPS: do everything else yourself. Ask me only for the steps the rules make human-only: the device-login code, the native screen recording for R6 and R12, genuine decision stops, the account-provenance statement, and the provider-side revocation. For each one, give me a single copy-paste block and wait.
```

## Vault destination decision (executor, 2026-10-31)
- Option 1 is not available. Get-Partition shows C: and D: both on DiskNumber 0; Get-PhysicalDisk lists one disk, "SK hynix PC801 HFS001TEJ9X101N SSD". The WSL distro ubuntu24.04.3 BasePath is `D:\WSL\ubuntu24.04.3` (HKCU Lxss), on that same disk.
- **Chosen: option 2, `/mnt/c/Users/icordoba/OneDrive/amt-evidence-vault-copy/`.** OneDrive.exe is running (PID 34700), and HKCU OneDrive\Accounts\Personal UserFolder = `C:\Users\icordoba\OneDrive`. The cloud copy is off-device; the local copy is still on physical disk 0.
