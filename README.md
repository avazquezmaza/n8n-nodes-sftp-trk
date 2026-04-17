# n8n-nodes-sftp-trk

Community node package for n8n that downloads files from SFTP with secure validation, filtering, and structured output.

## Compatibility

- n8n: 2.15.0+
- Node.js: 18+

## Installation

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
  - `Download a File Set`
  - `Upload a File`
  - `Delete a File or Folder`
  - `Rename / Move a File or Folder`

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

1. Node loads runtime parameters.
2. Node loads credential `SFTP TRK` from n8n.
3. Node connects to SFTP.
4. Node lists files in `remoteDirectory`.
5. Node applies filter rules and size limits.
6. Node downloads selected files (unless `listOnly=true`).
7. Node returns structured JSON output and attaches downloaded files as n8n binary data.
8. Node closes the SFTP connection in a `finally` block.

## Output Contract

The node returns one item with this shape:

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

When files are downloaded, the same item also contains one or more binary properties like `file_0`, `file_1`, and so on. Each file entry in `json.files` includes the related `binaryPropertyName` in its metadata.

## Security Notes

- Credentials are never accepted as plain node parameters.
- The SFTP credential is packaged with the node, so installation does not depend on external credential definitions.
- Sensitive values are redacted in logs.
- Remote paths are validated before SFTP operations.
- Pattern validation includes ReDoS safety checks.

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
