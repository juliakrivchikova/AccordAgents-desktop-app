# Bundled SQLite CLI for Windows x64

AccordAgents preserves its existing SQLite CLI persistence behavior on Windows by shipping the
official `sqlite3.exe` outside the Electron ASAR archive.

- Version: 3.53.4
- Source archive: `https://www.sqlite.org/2026/sqlite-tools-win-x64-3530400.zip`
- Archive SHA3-256: `88b4659fe747896b853af10157316b4ade143553efb89c1c8ca7423a278dcc8b`
- `sqlite3.exe` SHA-256: `5da2398d4913b893bd1ea578d85403b3a83a06fabf9d2303ca9f63ef0849fc6f`
- `sqlite3.exe` size: 4,022,272 bytes
- License: public domain, as stated by the SQLite project

Regenerate and verify the executable on Windows with Node.js 20 or later:

```powershell
node scripts/update-sqlite-win-x64.mjs
```
