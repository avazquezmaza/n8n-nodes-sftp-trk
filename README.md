# n8n-nodes-sftp-trk

Community node package for n8n that downloads files from SFTP with secure validation, filtering, and structured output.

## Compatibility

- n8n: 2.15.0+
- Node.js: 18+

## Installation

Use this exact command:

```bash
cd /home/node/.n8n && mkdir -p nodes && cd nodes && npm install --ignore-scripts git+https://github.com/avazquezmaza/.gin8n-nodes-sftp-trk.git
```

Then restart n8n.

## Node

- Node name: `SFTP Download TRK`
- Internal type: `sftpDownloadTrk`
- Credential included in this package: `SFTP TRK`

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
# n8n-nodes-sftp-trk
