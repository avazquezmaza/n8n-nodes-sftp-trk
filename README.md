# n8n-nodes-sftp-trk

Community node package for n8n that downloads files from SFTP with secure validation, filtering, and structured output.

## Compatibility

- n8n: 2.15.0+
- Node.js: 18+

## Installation

### Install From Git on Server

Use this when your package is not published to npm and you want to install directly from your Git repository.

1. Set repository and ref (branch, tag, or commit):

```bash
REPO_URL="https://github.com/avazquezmaza/n8n-nodes-sftp-trk.git"
REPO_REF="main"
```

2. Install in `n8n` (main):

```bash
docker exec -u node -it n8n sh -lc "cd /home/node/.n8n && npm install git+${REPO_URL}#${REPO_REF} --no-audit --no-fund"
```

3. Install in `n8n-worker`:

```bash
docker exec -u node -it n8n-worker sh -lc "cd /home/node/.n8n && npm install git+${REPO_URL}#${REPO_REF} --no-audit --no-fund"
```

4. Restart services:

```bash
docker compose restart n8n n8n-worker
```

5. Verify on both containers:

```bash
docker exec -u node -it n8n sh -lc "cd /home/node/.n8n && npm ls n8n-nodes-sftp-trk"
docker exec -u node -it n8n-worker sh -lc "cd /home/node/.n8n && npm ls n8n-nodes-sftp-trk"
```

Notes:
- Install in both `n8n` and `n8n-worker` when using queue mode.
- Avoid `--ignore-scripts`; this package uses `prepare` to build artifacts.
- For immutable deployments, prefer a tag or commit hash instead of `main`.

### Docker (recommended)

This project is designed to run in Docker-based n8n deployments, including queue mode (`n8n` + `n8n-worker`).

1. Update your `docker-compose.yml`.

Service `n8n` (`main`) must include:

```yaml
environment:
  - N8N_ENCRYPTION_KEY=<YOUR_SHARED_KEY>
  - N8N_COMMUNITY_PACKAGES_ENABLED=true
  - N8N_CUSTOM_EXTENSIONS=/home/node/.n8n/nodes/node_modules
volumes:
  - n8n_data:/home/node/.n8n
```

Service `n8n-worker` must include:

```yaml
environment:
  - N8N_ENCRYPTION_KEY=<YOUR_SHARED_KEY>
  - N8N_CUSTOM_EXTENSIONS=/home/node/.n8n/nodes/node_modules
volumes:
  - n8n_data:/home/node/.n8n
```

Notes:
- Use the same `N8N_ENCRYPTION_KEY` value in `n8n` and `n8n-worker`.
- Both services must mount the same `n8n_data` volume.
- Do not use `--ignore-scripts` when installing from Git, because this package compiles with `prepare`.

2. Recreate services after editing compose:

```bash
cd /docker/n8n && docker compose up -d --force-recreate n8n n8n-worker
```

3. Install package inside the `n8n` container:

```bash
docker exec n8n-n8n-1 sh -c "mkdir -p /home/node/.n8n/nodes && chown -R node:node /home/node/.n8n"
docker exec -u node n8n-n8n-1 sh -c "cd /home/node/.n8n/nodes && npm install git+https://github.com/avazquezmaza/n8n-nodes-sftp-trk.git --no-audit --no-fund"
```

4. Restart n8n services:

```bash
docker restart n8n-n8n-1 n8n-n8n-worker-1
```

5. Validate installation:

```bash
docker exec n8n-n8n-1 sh -c "ls /home/node/.n8n/nodes/node_modules/n8n-nodes-sftp-trk/dist/nodes/SftpDownload/"
docker exec n8n-n8n-1 node -e 'require("/home/node/.n8n/nodes/node_modules/n8n-nodes-sftp-trk/dist/nodes/SftpDownload/SftpDownload.node.js"); console.log("OK_IMPORT")'
docker logs n8n-n8n-1 --since 3m 2>&1 | grep -Ei "packages are missing|error"
```

Expected:
- `SftpDownload.node.js` exists.
- `OK_IMPORT` is printed.
- No `packages are missing` message appears.

Then open n8n UI, hard-refresh the browser (`Ctrl+Shift+R`), and search for `SFTP Download TRK` in the regular node picker (not AI Nodes).

## Node

- Node name: `SFTP Download TRK`
- Internal type: `sftpDownloadTrk`
- Credential included in this package: `SFTP TRK`
- Supported operations:
  - `List Folder Content`
  - `Download a File`
  - `Upload a File`
  - `Delete a File or Folder`
  - `Rename / Move a File or Folder`

### Download Behavior

The `Download a File` operation supports two modes:

1. `Single File` (official-like default)
- Uses `Path` as the remote file path.
- Stores the downloaded binary in `Put Output File in Field`.
- Returns one output item.

2. `Directory Set (Advanced)`
- Uses `Remote Directory` and `Download Mode` (`All Files` or `Filtered`).
- Supports `Filter Type` (`Extension`, `Pattern`, `Multi Pattern (JSON)`).
- Supports parallel download with `Download in Parallel` and `Max Concurrent Reads`.
- Can run as list-only with `Options -> List Only`.
- Returns one output item per processed file when files are produced.

## Architecture

This package is organized in layers to keep security and maintainability clear.

1. Node Layer
- File: `src/nodes/SftpDownload/SftpDownload.node.ts`
- Responsibilities:
  - Read node parameters
  - Read package-provided SFTP credential from n8n credential store
  - Orchestrate listing, filtering, and downloading
  - Build normalized output and attach binary files to the n8n item

2. Credential Layer
- File: `src/credentials/SftpTrk.credentials.ts`
- Responsibilities:
  - Define the SFTP credential required by the node
  - Keep installation self-contained inside n8n

3. SFTP Access Layer
- File: `src/utils/sftp-client.ts`
- Responsibilities:
  - Connect/disconnect lifecycle
  - Retry strategy for connection failures
  - Remote listing
  - File download with timeout

4. Filtering Layer
- File: `src/utils/filter-engine.ts`
- Responsibilities:
  - Include/exclude filtering with glob and regex
  - Exclusion precedence
  - Summary helpers
  - Size filtering utility

5. Validation Layer
- File: `src/utils/validators.ts`
- Responsibilities:
  - SFTP credential validation
  - Remote path validation and traversal prevention
  - Pattern safety validation

6. Error and Logging Layer
- Files:
  - `src/utils/error-handler.ts`
  - `src/utils/logger.ts`
- Responsibilities:
  - Standardized error mapping
  - Redacted structured logs
  - Safe user-facing messages

7. Shared Types
- File: `src/types/common.types.ts`
- Responsibilities:
  - Contracts for output, errors, files, filters, and credentials

## Execution Flow

1. Node loads runtime parameters and `SFTP TRK` credentials.
2. Node connects to SFTP.
3. Node executes by operation:
- `List Folder Content`: list by `Path`, apply optional recursive/size/count constraints, return structured list output.
- `Download a File` + `Single File`: download exact `Path`, attach binary to configured output field.
- `Download a File` + `Directory Set (Advanced)`: list `Remote Directory`, apply filters and limits, download sequentially or in parallel, return per-file items.
- `Upload a File`: read input binary field and upload to `Path`.
- `Delete a File or Folder`: remove target `Path`.
- `Rename / Move a File or Folder`: move from `Source Path` to `Destination Path`.
4. Node closes SFTP connection in a `finally` block.

## Output Contract

Output depends on the selected operation.

### Download - Single File

Returns one item with JSON metadata and one binary property in `Put Output File in Field`.

Example JSON:

```json
{
  "status": "success",
  "operation": "download",
  "timestamp": "ISO-8601",
  "path": "/exports/file.txt",
  "fileName": "file.txt",
  "sizeBytes": 12345,
  "durationMs": 150,
  "binaryField": "data"
}
```

### Download - Directory Set (Advanced)

If files are produced, returns one item per file. Each item includes file metadata plus binary content in `Put Output File in Field`.

If no file is produced (for example, only errors/skips), returns a summary item:

```json
{
  "status": "success | empty | partial_success | error",
  "timestamp": "ISO-8601",
  "directory": "/exports",
  "summary": {
    "totalFilesFound": 0,
    "totalFilesProcessed": 0,
    "totalFilesSkipped": 0,
    "totalByteDownloaded": 0,
    "totalDownloadTimeMs": 0,
    "averageBytesPerSecond": 0
  },
  "files": [],
  "errors": [],
  "warnings": []
}
```

### List Folder Content

Returns one summary item with listed files in `json.files` (list-only metadata, no binary payload).

### Upload / Delete / Rename-Move

Returns one success/error metadata item per input with operation-specific fields.

## Security Notes

- Credentials are never accepted as plain node parameters.
- The SFTP credential is packaged with the node, so installation does not depend on external credential definitions.
- Sensitive values are redacted in logs.
- Remote paths are validated before SFTP operations.
- Path validation is restricted by credential field `Allowed Base Path`.
  - Use `/` to allow any absolute remote path.
  - Use a specific base such as `/exports` or `/deliveries` to enforce directory boundaries.
- Pattern validation includes ReDoS safety checks.

## Troubleshooting

If you get:

`INVALID_PATH: Path is outside allowed directory`

Edit your `SFTP TRK` credential and set `Allowed Base Path` to match your SFTP layout, for example:
- `/deliveries` for paths like `/deliveries/licenses/...`
- `/` to allow any absolute path

## Development

Build:

```bash
npm run build
```

Type-check:

```bash
npx tsc --noEmit
```

Run tests:

```bash
npm test
```
