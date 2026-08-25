# Session Artifact Registry

Status: implemented image foundation

## Goal

Assistant messages may reference durable, session-bound binary artifacts without exposing Host or Executor paths. The canonical message URI is:

```text
artifact://<artifactId>
```

The Dashboard resolves it through the authenticated Host origin and reuses the chat image preview.

## Ownership and lifecycle

- Registration copies bytes into the Host-owned session artifact directory; source paths are never retained.
- Records bind one artifact ID to one session ID, media type, byte size, SHA-256, title, and immutable content filename.
- The registry is atomically replaced after the content file is fsynced.
- Content reads require both artifact ID and matching session ID and verify that the session still exists.
- Session JSONL remains the transcript source of truth; artifact bytes are side data referenced by URI.

## HTTP contract

### Register

```text
POST /session-artifacts/register
```

Input contains `sessionId`, `title`, `fileName`, and base64 `data`. The Host accepts PNG, JPEG, GIF, or WebP by magic bytes and rejects empty or oversized payloads.

Output includes the immutable `artifact://` URI.

### Read

```text
GET /session-artifacts/<artifactId>?sessionId=<sessionId>
```

The response has the stored image media type, immutable private cache headers, content length, and hash ETag. A mismatched session is rejected.

## Assistant local-image publication

Before an authoritative Assistant `llm_response` is reduced and persisted, the Host
scans non-fenced Markdown image references. Local Workspace or Executor-owned system
temporary images are read through a private Executor RPC, magic-byte validated,
copied into this registry, and rewritten to `artifact://<artifactId>`. Remote,
`data:`, `blob:`, and existing `artifact:` URLs are untouched. Publication failure
becomes readable `Image unavailable` text rather than a broken browser URL. The
JSONL therefore remains stable across refresh, reconnect, device change, and source
file deletion.

## Dashboard behavior

`ReactMarkdown` preserves `artifact://` image URLs. The custom image renderer converts them to the session-bound HTTP URL, renders a lazy thumbnail, provides a full-viewport preview, and displays a readable error fallback.

## Security constraints

- No absolute path is returned to the browser or persisted in the registry.
- Registration is a byte-copy boundary, not a path-serving endpoint.
- SVG and unknown formats are rejected.
- Maximum image size is 10 MiB.
- Content files and registry files are created with mode `0600`; directories use `0700`.
- Future generic artifact kinds must define independent MIME, size, active-content, retention, and rendering policies rather than weakening the image policy.
