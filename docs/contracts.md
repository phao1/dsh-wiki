# DSH Wiki implementation contract

Node ESM, no mandatory runtime dependencies. This contract coordinates implementation.

## Core

`packages/core/index.mjs` exports `WikiStore`.

`new WikiStore({ dataDir, seedPath })`; `await store.init()` loads `dataDir/state.json` or a seed JSON `{version:1, sources:[], documents:[]}`. Seed documents use `{path, markdown, sourceId, sourceUrl, sourceRevision, fetchedAt, category?, tags?, language?}`. Import accepts the same format. All public methods may be awaited.

- `status()` → `{documentCount, sectionCount, sources, categories:[{name,count}], tags:[{name,count}], languages:[{name,count}], freshness:{fresh,stale,unverified}, lastUpdated, version}`. Source has `{id,name,type,url,revision,checkedAt,documentCount}`.
- `listDocuments({category,tag,language,sourceId,limit=100,offset=0}={})` → `{total,documents}`.
- `search(query,{category,tag,language,sourceId,limit=20}={})` → `{query,total,results:[{...documentSummary,score,snippet,sectionAnchor,sectionTitle,matchedTerms}]}`. Blank query lists documents.
- `getDocument(id)` → full document or null.
- `contextPack({query='',ids=[],budget=4000}={})` → `{markdown,tokenEstimate,budget,documents:[{id,title,sourceUrl,hash}],truncated,warnings}`. Approximate tokens must be labeled; budget must bound content, output contains citations and source hash.
- `importDocuments(documents,{source={id,name,type,url,revision,checkedAt},replace=false}={})` → `{added,changed,unchanged,removed,version,changes}`. Atomic persisted state. Only replace docs of this source; no deletion on partial failure upstream. Serialization prevents lost concurrent writes.
- `history()` → change batches newest first `{id,at,sourceId,added,changed,removed,changes:[{documentId,title,type,beforeHash,afterHash}]}`.
- `diff(documentId)` → `{documentId,title,before,after,changes:[{type:'added'|'removed'|'same',text}]}` for latest retained version; null if absent.

Document summary: `{id,path,title,category,tags,language,sourceId,sourceUrl,sourceRevision,fetchedAt,verifiedAt,hash,status,wordCount,tokenEstimate,sectionCount,excerpt}`. Full document additionally has `body`, `sections:[{anchor,title,startLine,endLine,body}]`, `links:[{id,title,sourceUrl}]`, `backlinks:[{id,title,sourceUrl}]`. Status is fresh/stale/unverified, based on real fetchedAt/verifiedAt and 14 days, never newly-imported time for old source content.

## HTTP (port 4310, loopback)

- GET `/api/status`
- GET `/api/documents?category=&tag=&language=&sourceId=&limit=&offset=`
- GET `/api/search?q=...` with same filters
- GET `/api/document?id=...`
- GET `/api/history`
- GET `/api/diff?id=...`
- POST `/api/context` body `{query,ids,budget}`
- POST `/api/import` body `{documents:[{path,markdown}],source:{id,name,type:'local'},replace:false}`
- POST `/api/sync` body `{}` checks/retrieves bundled public DSH GitHub source at current master; HTTP network failures are real errors, never fake updates. Sync uses configured known source paths, immutable resolved commit and atomic batch.
- GET `/api/export?format=manifest|llms|index|crossrefs` downloads JSON/Markdown/text.

Errors `{error: string, code?: string}` with appropriate non-2xx. Writes require same origin and JSON, loopback binding. Frontend escapes untrusted text/Markdown and blocks javascript links.

## UI

Vanilla ESM HTML/CSS/JS in `web/`, served by lead's `server/index.mjs`. Shared API above. A working searchable knowledge workbench: library/search, document with source/sections/backlinks, context selection/export, updates/diff, sources/import. Chinese primary UI, English technical labels. Responsive, accessible, polished desktop layout. No fake stats.

## Portable Markdown snapshot

`node cli/wiki.mjs export --format markdown --out <new-directory>` delegates to `server/export-corpus.mjs:exportCorpus(store, outputDir)` and returns `{outputDir,documentCount,fileCount}`. Existing destinations are rejected. Documents are grouped by source, unsafe paths are rejected, filename collisions receive stable mappings in `manifest.json`. The export includes YAML metadata, original body, INDEX/TAGS/llms/manifest/crossrefs, source and export byte hashes, and applicable license notices.

Document metadata additionally preserves optional `lastModified` independently from fetched/verified time. It does not affect freshness.
