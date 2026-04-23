# n8n-nodes-sftp-trk

Community node package for n8n that provides secure SFTP file operations with advanced filtering, path validation, and structured output.

## Compatibility

- n8n: 2.15.0+
- Node.js: 18+

## Node

- **Display name:** SFTP Download TRK
- **Internal type:** `sftpDownloadTrk`
- **Credential:** SFTP TRK (`sftpTrk`) — packaged with this node, no external definition needed

### Supported operations

| Operation | Description |
|---|---|
| List Folder Content | List remote directory. Returns one item per file (official) or a summary item (detailed). |
| Download a File | Single file or directory-set batch with filtering and optional parallel download. |
| Upload a File | Upload binary from input item to a remote path. |
| Delete a File or Folder | Delete a file or directory tree. |
| Rename / Move a File or Folder | Move source to destination. |

### Download modes

**Single File** — Uses the `Path` parameter directly. Returns one item with JSON metadata and binary in `Put Output File in Field`.

**Directory Set (Advanced)** — Lists `Remote Directory`, applies filters and limits, then downloads. Returns one item per file. Options:

- `Download Mode`: All Files or Filtered
- `Filter Type`: Extension · Pattern (glob/regex) · Multi Pattern (JSON array)
- `Download in Parallel` + `Max Concurrent Reads`
- `List Only`: list files without downloading content
- `Max File Size (MB)` / `Max Files Count` / `File Timeout (Seconds)`
- `Skip Errors`: continue on per-file failures (default: on)

## Output contract

### Download — Single File

```json
{
  "status": "success",
  "operation": "download",
  "timestamp": "ISO-8601",
  "path": "/exports/file.csv",
  "fileName": "file.csv",
  "sizeBytes": 12345,
  "durationMs": 150,
  "binaryField": "data"
}
```

### Download — Directory Set (per-file items)

Each item contains file metadata in `json.file` plus binary content in the configured output field.

When no file is produced (e.g. all filtered out or all errors), a single summary item is returned:

```json
{
  "status": "success | empty | partial_success | error",
  "timestamp": "ISO-8601",
  "directory": "/exports",
  "summary": {
    "totalFilesFound": 10,
    "totalFilesProcessed": 8,
    "totalFilesSkipped": 2,
    "totalByteDownloaded": 204800,
    "totalDownloadTimeMs": 3200,
    "averageBytesPerSecond": 64000
  },
  "files": [...],
  "errors": [...],
  "warnings": [...]
}
```

### List Folder Content — Official format (default)

One item per file:

```json
{ "name": "report.csv", "path": "/exports/report.csv", "type": "file", "size": 4096, "modifiedAt": "ISO-8601" }
```

### Upload / Delete / Move

One success item per input with operation-specific fields (`remoteFilePath`, `deletePath`, `sourcePath`/`destinationPath`).

## Security

- Credentials are never accepted as plain node parameters — always fetched via n8n credential store.
- **Allowed Base Path** in the credential restricts all SFTP operations to a directory boundary.
  - Use `/` to allow any absolute path.
  - Use `/exports` or `/deliveries` to enforce directory scope.
- Remote paths are validated before every SFTP call (path traversal prevention).
- Regex patterns from user input are checked for ReDoS risk before being compiled.
- All sensitive fields (`password`, `privateKey`) are automatically redacted from structured logs.

### Troubleshooting: `INVALID_PATH: Path is outside allowed directory`

Edit the `SFTP TRK` credential and set `Allowed Base Path` to match your SFTP layout:

- `/deliveries` for paths like `/deliveries/licenses/...`
- `/` to allow any absolute path

## Development

```bash
npm run build          # Compile TypeScript → dist/
npm run dev            # Watch mode
npm run test           # Jest with 80% coverage threshold (all suites)
npm run test:unit      # Unit tests only
npm run lint           # ESLint
npm run lint:fix       # ESLint with auto-fix
npm run prepush        # lint + test + build (run before pushing)
```

Run a single test file:

```bash
npx jest src/__tests__/unit/sftp-download-node.test.ts
```

### Architecture

The package is organized in layers:

| Layer | File | Responsibility |
|---|---|---|
| Node | `src/nodes/SftpDownload/SftpDownload.node.ts` | Parameter reading, operation dispatch, n8n output |
| Credential | `src/credentials/SftpTrk.credentials.ts` | SFTP credential type definition |
| SFTP Access | `src/utils/sftp-client.ts` | Connection lifecycle, retry, download with timeout |
| Filtering | `src/utils/filter-engine.ts` | Include/exclude rules (glob, regex), size filter |
| Validation | `src/utils/validators.ts` | Path traversal prevention, ReDoS detection, resource limits |
| Error mapping | `src/utils/error-handler.ts` | Technical → user-safe error messages with error codes |
| Logging | `src/utils/logger.ts` | Pino structured logging with automatic credential redaction |
| Types | `src/types/common.types.ts` | Shared interfaces and enums |

### Execution flow

1. Node reads runtime parameters and `SFTP TRK` credentials from n8n credential store.
2. Creates an `SftpClient` with per-item timeout settings.
3. Connects to SFTP (up to 3 retries with exponential backoff).
4. Dispatches to the appropriate operation handler.
5. Closes the SFTP connection in a `finally` block — always, even on error.

---

## Deployment on n8n server

### Install from Git

Use this when the package is not published to npm.

**Step 1 — Set variables:**

```bash
REPO_URL="https://github.com/avazquezmaza/n8n-nodes-sftp-trk.git"
REPO_REF="main"   # or a tag like v1.2.0 for immutable installs
```

**Step 2 — Install in both containers** (required in queue mode):

```bash
docker exec -u node -it n8n sh -lc \
  "cd /home/node/.n8n && npm install git+${REPO_URL}#${REPO_REF} --no-audit --no-fund"

docker exec -u node -it n8n-worker sh -lc \
  "cd /home/node/.n8n && npm install git+${REPO_URL}#${REPO_REF} --no-audit --no-fund"
```

> Do not use `--ignore-scripts`. This package compiles with the `prepare` script.

**Step 3 — Restart services:**

```bash
docker compose restart n8n n8n-worker
```

**Step 4 — Verify:**

```bash
docker exec -u node -it n8n sh -lc "cd /home/node/.n8n && npm ls n8n-nodes-sftp-trk"
docker exec n8n-n8n-1 node -e \
  'require("/home/node/.n8n/node_modules/n8n-nodes-sftp-trk/dist/nodes/SftpDownload/SftpDownload.node.js"); console.log("OK")'
```

Open n8n UI, hard-refresh (`Ctrl+Shift+R`), and search for **SFTP Download TRK** in the node picker.

---

### Update to a new version

```bash
REPO_URL="https://github.com/avazquezmaza/n8n-nodes-sftp-trk.git"
REPO_REF="main"   # or a specific tag/commit

docker exec -u node -it n8n sh -lc \
  "cd /home/node/.n8n && npm install git+${REPO_URL}#${REPO_REF} --no-audit --no-fund"

docker exec -u node -it n8n-worker sh -lc \
  "cd /home/node/.n8n && npm install git+${REPO_URL}#${REPO_REF} --no-audit --no-fund"

docker compose restart n8n n8n-worker
```

---

### Docker Compose environment variables

Both `n8n` and `n8n-worker` services must share the same data volume and encryption key:

```yaml
# n8n (main)
environment:
  - N8N_ENCRYPTION_KEY=<YOUR_SHARED_KEY>
  - N8N_COMMUNITY_PACKAGES_ENABLED=true
  - N8N_CUSTOM_EXTENSIONS=/home/node/.n8n/nodes/node_modules
volumes:
  - n8n_data:/home/node/.n8n

# n8n-worker
environment:
  - N8N_ENCRYPTION_KEY=<YOUR_SHARED_KEY>
  - N8N_CUSTOM_EXTENSIONS=/home/node/.n8n/nodes/node_modules
volumes:
  - n8n_data:/home/node/.n8n
```

After editing `docker-compose.yml`:

```bash
cd /docker/n8n && docker compose up -d --force-recreate n8n n8n-worker
```

---

### Diagnosing install issues

```bash
# Check the node file exists
docker exec n8n-n8n-1 sh -c \
  "ls /home/node/.n8n/nodes/node_modules/n8n-nodes-sftp-trk/dist/nodes/SftpDownload/"

# Check for load errors in recent logs
docker logs n8n-n8n-1 --since 3m 2>&1 | grep -Ei "packages are missing|error"
```
