# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**n8n-nodes-sftp-trk** is a custom n8n community node package for secure SFTP file operations. It provides list, download, upload, delete, and rename operations with advanced filtering, path validation, and structured output.

Targets: n8n 2.15.0+, Node.js 18+.

## Common Commands

```bash
npm run build          # Compile TypeScript → dist/
npm run dev            # Watch mode compilation
npm run test           # Jest with 80% coverage threshold
npm run test:watch     # Jest watch mode
npm run test:unit      # Unit tests only (src/__tests__/unit/)
npm run lint           # ESLint on src/
npm run lint:fix       # ESLint with auto-fix
npm run format         # Prettier format src/
npm run clean          # Remove dist/ and coverage/
npm run prepush        # lint + test + build (run before pushing)
```

Run a single test file:
```bash
npx jest src/__tests__/unit/validators.test.ts
```

## Architecture

The node follows a strict layered architecture. Each layer has a single responsibility:

### 1. Node Layer — `src/nodes/SftpDownload/SftpDownload.node.ts`
Implements `INodeType`. Reads n8n UI parameters, orchestrates SFTP operations, and builds normalized output items with binary attachments. This is the only file that touches the n8n workflow API.

### 2. Credential Layer — `src/credentials/SftpTrk.credentials.ts`
Defines the `sftpTrk` credential type (password or private key auth). Includes an "Allowed Base Path" field that acts as a security boundary — the SFTP client enforces that all paths stay within it.

### 3. SFTP Access Layer — `src/utils/sftp-client.ts`
Wraps `ssh2-sftp-client`. Manages connection lifecycle with retry logic (max 3 retries, exponential backoff), per-file timeouts (default 120s), and optional recursive listing. Never exposes credentials in logs or errors.

### 4. Filtering Layer — `src/utils/filter-engine.ts`
Evaluates files against inclusion/exclusion rules using glob patterns (`minimatch`) or regex. Exclusion rules always take priority. Returns `FilterResult` with reasoning for each decision.

### 5. Validation Layer — `src/utils/validators.ts`
Enforces: path traversal prevention (blocks `../`), allowed base path boundaries, ReDoS protection (dangerous regex pattern detection + 255-char limit), file size (0.001–5120 MB), file count (10K max), and timeout (10–3600s) resource limits.

### 6. Error & Logging Layer
- `src/utils/error-handler.ts`: Maps technical ssh2 errors to structured `ErrorCode` values (e.g., `SFTP_AUTH_FAILED`, `PATH_TRAVERSAL_ATTEMPT`) with user-safe messages.
- `src/utils/logger.ts`: Pino-based structured logging with automatic redaction of `password`, `privateKey`, `token`, and similar fields from all log output.

### 7. Types — `src/types/common.types.ts`
Single source of truth for all interfaces and enums: `LogEvent`, `ErrorCode`, `RemoteFileInfo`, `DownloadedFile`, `SftpDownloadOutput`, `FilterPattern`, etc. When adding new shared types, put them here.

## N8n Node Conventions

The node is registered in `package.json` under `n8n.nodes` and `n8n.credentials`. After building, n8n loads from `dist/`. The node name (`sftpDownloadTrk`) and credential name (`sftpTrk`) must stay stable — changing them breaks existing workflows.

**Operations supported:** List, Download (single file or directory-set batch mode), Upload, Delete, Rename/Move.

**Download modes:**
- *Single File*: downloads exact path, returns one item with JSON metadata + binary data.
- *Directory Set (Advanced)*: batch with filtering, parallel downloads, returns per-file items or a single summary item.

## Security-First Conventions

These are enforced throughout the codebase — maintain them in all changes:

- Credentials are **never** accepted as node input parameters; always fetched via `getCredentials()`.
- All remote paths go through `validateRemotePath()` before use.
- Regex patterns from user input must pass ReDoS detection before being compiled.
- Sensitive fields (`password`, `privateKey`) are never logged — Pino's `redact.paths` handles this, but don't add new log statements that pass credential objects directly.
- Error messages shown to users are mapped through `error-handler.ts` — never expose raw `ssh2` error text.

## TypeScript

Strict mode is enabled (`noImplicitAny`, `strictNullChecks`, `noUnusedLocals`). Use the type coercion helpers in `common.types.ts` (`toStringValue`, `toOptionalString`, `toOptionalNumber`) rather than casting parameters directly.

## Testing

Jest runs from `src/` with `ts-jest`. 80% coverage is enforced on branches, functions, lines, and statements — the build will fail if coverage drops. Unit tests live in `src/__tests__/unit/`, one file per utility module.

Test files by layer:
- `sftp-download-node.test.ts` — node routing, all operations, error handling, credential parsing
- `sftp-client.test.ts` — connect/retry/disconnect/list/download
- `filter-engine.test.ts` — glob, regex, multi-pattern, size filter
- `validators.test.ts` — path traversal, ReDoS, size limits
- `error-handler.test.ts` — error mapping and sanitization
- `logger.test.ts` — redaction and structured output

## Production server (Docker queue mode)

Container names: `n8n-n8n-1` (main) · `n8n-n8n-worker-1` (worker).

Both containers mount the same `n8n_data` volume at `/home/node/.n8n`. Installing once on `n8n-n8n-1` is sufficient.

**Critical path:** n8n reads community nodes from `N8N_CUSTOM_EXTENSIONS=/home/node/.n8n/nodes/node_modules`. Always install with `cd /home/node/.n8n/nodes`, not `cd /home/node/.n8n` — wrong path causes the `packages are missing` warning.

**Deploy / update:**

```bash
docker exec -u node -it n8n-n8n-1 sh -lc \
  "cd /home/node/.n8n/nodes && npm install git+https://github.com/avazquezmaza/n8n-nodes-sftp-trk.git#main --no-audit --no-fund"

docker restart n8n-n8n-1 n8n-n8n-worker-1
```

**Verify after restart:**

```bash
docker exec n8n-n8n-1 node -e \
  'require("/home/node/.n8n/nodes/node_modules/n8n-nodes-sftp-trk/dist/nodes/SftpDownload/SftpDownload.node.js"); console.log("OK")'

docker logs n8n-n8n-1 --since 2m 2>&1 | grep -Ei "packages are missing|sftp"
```
