# `@kritano/cms-plugin-io` — Build Task Document
**Content Export / Import Plugin**
**For use with Kritano Team Skill / Claude Code Manager**
**Priority:** Build before portfolio goes live — needed for local → production content migration

---

## Why this plugin exists

When you build a site locally and fill it with content, there is no built-in way to move that content to a live server. You would have to recreate everything manually in the production admin — which is completely unacceptable.

This plugin solves two distinct problems:

**1. Environment migration** — move content from local development to a live server, or from one server to another. This is the primary use case.

**2. Backup and restore** — export a complete snapshot of all content at any point in time. Restore it if something goes wrong.

A secondary use case that emerges from having this plugin is **content seeding** — export a set of content from one site and import it as a starting point on a new site. Useful for agencies spinning up new client sites based on a reference setup.

---

## Package structure

```
plugins/
└── io/
    ├── package.json
    ├── src/
    │   ├── index.ts              # definePlugin() entry point
    │   ├── exporter/
    │   │   ├── index.ts          # Export orchestrator
    │   │   ├── collections.ts    # Export documents from all collections
    │   │   ├── media.ts          # Export media files and records
    │   │   ├── settings.ts       # Export site settings
    │   │   └── manifest.ts       # Generate export manifest
    │   ├── importer/
    │   │   ├── index.ts          # Import orchestrator
    │   │   ├── validate.ts       # Validate import package before applying
    │   │   ├── collections.ts    # Import documents, resolve conflicts
    │   │   ├── media.ts          # Import media files
    │   │   ├── settings.ts       # Import site settings (optional)
    │   │   └── relations.ts      # Resolve cross-document relations after import
    │   ├── formats/
    │   │   ├── zip.ts            # ZIP package creation and extraction
    │   │   └── json.ts           # JSON serialisation helpers
    │   └── admin/
    │       ├── ExportPanel.tsx   # Admin UI — export configuration and download
    │       ├── ImportPanel.tsx   # Admin UI — upload, validate, preview, import
    │       ├── ImportProgress.tsx # Live progress during import
    │       └── ImportConflicts.tsx # Conflict resolution UI
    ├── docs/
    │   └── io-plugin.md          # Plugin-specific documentation
    └── tests/
        ├── export.test.ts
        ├── import.test.ts
        └── roundtrip.test.ts     # Export then import, verify identical
```

---

## Export format

The export is a ZIP file. ZIP is chosen over plain JSON because it needs to bundle binary media files alongside structured content data. The ZIP is self-contained — everything needed to restore a site is in one file.

### ZIP structure

```
export-2025-06-05-143022.zip
├── manifest.json              ← Always read first — describes the export
├── collections/
│   ├── article/
│   │   ├── article-id-1.json
│   │   ├── article-id-2.json
│   │   └── article-id-3.json
│   ├── page/
│   │   ├── page-id-1.json
│   │   └── page-id-2.json
│   └── project/
│       └── project-id-1.json
├── media/
│   ├── records.json           ← All media metadata records
│   └── files/
│       ├── image-uuid-1.jpg
│       ├── image-uuid-1.webp  ← Both original and converted WebP
│       ├── image-uuid-2.png
│       └── document-uuid.pdf
└── settings.json              ← Site config (name, domain, language, theme settings)
```

### `manifest.json`

The manifest is the first thing read on import. It tells the importer what to expect and whether the import package is compatible with the current CMS version.

```typescript
interface ExportManifest {
  version: '1.0'                     // manifest format version
  cmsVersion: string                 // CMS version that generated this export
  exportedAt: string                 // ISO timestamp
  exportedFrom: string               // site domain
  collections: {
    [collectionName: string]: {
      count: number                  // number of documents
      schema: CollectionSchema       // full schema snapshot at export time
    }
  }
  media: {
    count: number                    // number of media records
    totalSizeBytes: number           // total size of media files
  }
  options: ExportOptions             // what was included in this export
  checksum: string                   // SHA-256 of all content files concatenated
                                     // used to verify integrity on import
}
```

Example:

```json
{
  "version": "1.0",
  "cmsVersion": "0.4.0",
  "exportedAt": "2025-06-05T14:30:22Z",
  "exportedFrom": "https://my-local-site.com",
  "collections": {
    "article": {
      "count": 12,
      "schema": { "fields": { "title": { "type": "text" }, "body": { "type": "richText" } } }
    },
    "page": {
      "count": 5,
      "schema": { "fields": { "title": { "type": "text" }, "content": { "type": "blocks" } } }
    }
  },
  "media": {
    "count": 34,
    "totalSizeBytes": 18432000
  },
  "options": {
    "collections": ["article", "page", "project"],
    "includeMedia": true,
    "includeSettings": false,
    "statusFilter": "all"
  },
  "checksum": "sha256:abc123..."
}
```

### Document JSON format

Each document is exported as a single JSON file named `{document-id}.json`:

```typescript
interface ExportedDocument {
  id: string
  collection: string
  status: 'draft' | 'published'
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  fields: Record<string, unknown>    // all field values as stored in the database
  relations: {
    // Relations stored as IDs within this export package
    // Resolved to actual IDs on the target system during import
    [fieldName: string]: string | string[]
  }
  blocks?: ExportedBlock[]           // if any fields are blocks()
  seo?: SeoBlock                     // if document has seoBlock() field
}

interface ExportedBlock {
  id: string                         // original block ID (uuid)
  type: string                       // block type name
  fields: Record<string, unknown>    // block field values
  mediaRefs: string[]                // media IDs referenced in this block
}
```

### Media records JSON

`media/records.json` is an array of all media metadata:

```typescript
interface ExportedMediaRecord {
  id: string
  originalFilename: string
  filename: string               // the filename as stored (uuid-based)
  mimeType: string
  size: number
  width: number | null
  height: number | null
  alt: string
  folderId: string | null
  createdAt: string
  // File is at media/files/{filename}
}
```

---

## Export options

The admin export panel lets the user configure what to include:

```typescript
interface ExportOptions {
  // Which collections to export — defaults to all
  collections: string[] | 'all'

  // Which document statuses to include
  statusFilter: 'all' | 'published' | 'draft'

  // Include media files in the ZIP
  // False = export records only, not the actual files (faster, smaller)
  includeMedia: boolean

  // Include site settings (name, domain, theme settings)
  // Default false — settings are usually environment-specific
  includeSettings: boolean
}
```

---

## Import behaviour

### Conflict resolution strategy

When importing into a CMS that already has content, there will be conflicts — documents with the same ID or the same slug already exist. The importer offers three strategies:

```typescript
type ConflictStrategy =
  | 'skip'       // Skip existing documents — only import new ones
  | 'overwrite'  // Overwrite existing documents with imported data
  | 'duplicate'  // Import as new documents with new IDs (slugs get -2, -3 suffix)
```

The admin import panel lets the user choose the strategy before the import runs. Default is `skip`.

### Import phases

Import runs in five distinct phases with clear progress reporting:

```
Phase 1: Validate        — check manifest, schema compatibility, file integrity
Phase 2: Preview         — show what will be imported, list conflicts
Phase 3: Media           — copy media files to the correct location
Phase 4: Documents       — insert/update documents in the database
Phase 5: Relations       — resolve cross-document relation fields
Phase 6: Verify          — check imported counts match expected counts
```

Phases 1 and 2 run before anything is written. The user sees the preview and must confirm before phases 3-6 run. If anything in phases 3-6 fails, the entire import is rolled back via a database transaction.

### Schema compatibility

The manifest includes the schema snapshot from the source CMS. On import, the importer compares the exported schema against the current schema:

**Compatible (import proceeds):**
- Source has fewer fields than target — extra target fields get their default values
- Field types match exactly

**Warning (user must confirm):**
- Source has more fields than target — extra source fields are silently dropped
- Field types differ but are safely coercible (e.g. `text` → `textarea`)

**Incompatible (import blocked):**
- A field type in the source cannot be mapped to the target at all
- A required field in the target has no value in the source and no default

### Relation resolution

Relations are the tricky part. A document might reference another document by ID (`author: "uuid-of-user"`). On the target system, that UUID might not exist or might belong to a completely different document.

The relation resolver works through this after all documents are inserted:

```typescript
async function resolveRelations(
  importedDocs: ImportedDocument[],
  idMap: Map<string, string>   // source ID → target ID mapping
) {
  for (const doc of importedDocs) {
    for (const [fieldName, fieldDef] of Object.entries(doc.schema.fields)) {
      if (fieldDef.type === 'relation') {
        const sourceId = doc.fields[fieldName]
        // Check if the referenced document was also imported
        if (idMap.has(sourceId)) {
          // Update the field to point to the new target ID
          doc.fields[fieldName] = idMap.get(sourceId)
        } else {
          // Referenced document was not in the import package
          // Attempt to find by slug on the target system
          const targetDoc = await findBySlug(fieldDef.target, sourceId)
          if (targetDoc) {
            doc.fields[fieldName] = targetDoc.id
          } else {
            // Cannot resolve — set to null, log warning
            doc.fields[fieldName] = null
            warnings.push(`Relation ${fieldName} on ${doc.id} could not be resolved`)
          }
        }
      }
    }
  }
}
```

---

## Plugin implementation

### `src/index.ts` — plugin registration

```typescript
import { definePlugin } from '@kritano/cms/core'
import { ExportPanel } from './admin/ExportPanel'
import { ImportPanel } from './admin/ImportPanel'
import { exportHandler } from './api/export'
import { importHandler } from './api/import'
import { importStatusHandler } from './api/import-status'

export default definePlugin({
  name: '@kritano/cms-plugin-io',
  version: '1.0.0',
  description: 'Export and import content between CMS instances',
  author: 'Kritano',
  trust: 'trusted',
  cms: {
    minVersion: '0.1.0',
  },

  setup({ api, admin }) {

    // API routes
    api.post('/export', exportHandler)
    api.post('/import', importHandler)
    api.get('/import/status/:jobId', importStatusHandler)
    api.delete('/import/:jobId', cancelImportHandler)

    // Admin UI sections
    admin.registerSection({
      label: 'Export / Import',
      icon: 'arrow-left-right',
      path: '/io',
      component: IOPanel,      // Parent component that renders both panels
    })

    // Register a dashboard widget showing last export date
    admin.registerDashboardWidget({
      id: 'io-last-export',
      label: 'Last Export',
      component: LastExportWidget,
      size: 'small',
    })
  }
})
```

---

### `src/exporter/index.ts` — export orchestrator

```typescript
import JSZip from 'jszip'
import { generateManifest } from './manifest'
import { exportCollections } from './collections'
import { exportMedia } from './media'
import { exportSettings } from './settings'

export async function runExport(
  options: ExportOptions,
  cms: CMSServices
): Promise<Buffer> {

  const zip = new JSZip()
  const exportId = `export-${new Date().toISOString().replace(/[:.]/g, '-')}`

  // 1. Export collections
  const { documents, idMap } = await exportCollections(options, cms)
  for (const [collection, docs] of Object.entries(documents)) {
    for (const doc of docs) {
      zip.file(
        `collections/${collection}/${doc.id}.json`,
        JSON.stringify(doc, null, 2)
      )
    }
  }

  // 2. Export media
  if (options.includeMedia) {
    const { records, files } = await exportMedia(documents, cms)
    zip.file('media/records.json', JSON.stringify(records, null, 2))
    for (const [filename, buffer] of Object.entries(files)) {
      zip.file(`media/files/${filename}`, buffer)
    }
  }

  // 3. Export settings
  if (options.includeSettings) {
    const settings = await exportSettings(cms)
    zip.file('settings.json', JSON.stringify(settings, null, 2))
  }

  // 4. Generate and add manifest
  const manifest = await generateManifest(options, documents, cms)
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))

  // 5. Generate ZIP buffer
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
}
```

---

### `src/exporter/collections.ts` — document export

```typescript
export async function exportCollections(
  options: ExportOptions,
  cms: CMSServices
): Promise<{ documents: Record<string, ExportedDocument[]>, idMap: Map<string, string> }> {

  const collections = options.collections === 'all'
    ? cms.schema.getCollectionNames()
    : options.collections

  const documents: Record<string, ExportedDocument[]> = {}
  const idMap = new Map<string, string>()

  for (const collectionName of collections) {
    const schema = cms.schema.getCollection(collectionName)

    // Fetch all documents matching status filter
    const where = options.statusFilter === 'all'
      ? undefined
      : { status: options.statusFilter }

    const docs = await cms.collections.findMany(collectionName, { where })

    documents[collectionName] = docs.map(doc => {
      idMap.set(doc.id, doc.id)  // identity map for this export

      return {
        id: doc.id,
        collection: collectionName,
        status: doc.status,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        publishedAt: doc.publishedAt ?? null,
        fields: serializeFields(doc, schema),
        relations: extractRelations(doc, schema),
        blocks: extractBlocks(doc, schema),
        seo: doc.seo ?? null,
      }
    })
  }

  return { documents, idMap }
}

// Serialize field values — handles special types
function serializeFields(
  doc: Document,
  schema: CollectionSchema
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}

  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    const value = doc[fieldName]

    switch (fieldDef.type) {
      case 'datetime':
        // Store as ISO string, not Date object
        fields[fieldName] = value instanceof Date ? value.toISOString() : value
        break
      case 'richText':
        // Store TipTap JSON as-is — it's already serializable
        fields[fieldName] = value
        break
      case 'blocks':
        // Blocks extracted separately — store reference only
        fields[fieldName] = `__blocks__`
        break
      case 'media':
        // Store media ID — media records exported separately
        fields[fieldName] = value?.id ?? null
        break
      case 'relation':
        // Store referenced document ID — resolved on import
        fields[fieldName] = value?.id ?? null
        break
      default:
        fields[fieldName] = value
    }
  }

  return fields
}
```

---

### `src/exporter/media.ts` — media export

```typescript
import fs from 'fs/promises'
import path from 'path'

export async function exportMedia(
  documents: Record<string, ExportedDocument[]>,
  cms: CMSServices
): Promise<{ records: ExportedMediaRecord[], files: Record<string, Buffer> }> {

  // Collect all media IDs referenced across all documents
  const referencedMediaIds = new Set<string>()

  for (const docs of Object.values(documents)) {
    for (const doc of docs) {
      collectMediaIds(doc, referencedMediaIds)
    }
  }

  // Fetch media records
  const mediaRecords = await cms.media.findMany({
    where: { id: { in: Array.from(referencedMediaIds) } }
  })

  // Read actual files from disk
  const files: Record<string, Buffer> = {}
  const mediaPath = process.env.MEDIA_PATH || './media'

  for (const record of mediaRecords) {
    try {
      // Export original file
      const originalPath = path.join(mediaPath, record.filename)
      files[record.filename] = await fs.readFile(originalPath)

      // Export WebP version if it exists
      const webpFilename = record.filename.replace(/\.[^.]+$/, '.webp')
      const webpPath = path.join(mediaPath, webpFilename)
      try {
        files[webpFilename] = await fs.readFile(webpPath)
      } catch {
        // WebP version doesn't exist — skip silently
      }
    } catch (err) {
      console.warn(`[io-plugin] Could not read media file: ${record.filename}`)
    }
  }

  const records: ExportedMediaRecord[] = mediaRecords.map(r => ({
    id: r.id,
    originalFilename: r.originalFilename,
    filename: r.filename,
    mimeType: r.mimeType,
    size: r.size,
    width: r.width ?? null,
    height: r.height ?? null,
    alt: r.alt,
    folderId: r.folderId ?? null,
    createdAt: r.createdAt,
  }))

  return { records, files }
}

function collectMediaIds(doc: ExportedDocument, ids: Set<string>) {
  // Collect from top-level media fields
  for (const [, value] of Object.entries(doc.fields)) {
    if (typeof value === 'string' && isMediaId(value)) {
      ids.add(value)
    }
  }
  // Collect from blocks
  if (doc.blocks) {
    for (const block of doc.blocks) {
      for (const mediaId of block.mediaRefs) {
        ids.add(mediaId)
      }
    }
  }
}
```

---

### `src/importer/validate.ts` — validation before import

```typescript
export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
  preview: ImportPreview
}

export interface ImportPreview {
  collections: {
    [name: string]: {
      total: number
      new: number           // documents not on target
      conflicts: number     // documents that already exist
      incompatible: number  // documents that cannot be imported
    }
  }
  media: {
    total: number
    totalSizeBytes: number
    alreadyExists: number
  }
  estimatedDurationMs: number
}

export async function validateImport(
  zip: JSZip,
  cms: CMSServices
): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  // 1. Read and parse manifest
  const manifestFile = zip.file('manifest.json')
  if (!manifestFile) {
    return { valid: false, errors: [{ code: 'MISSING_MANIFEST', message: 'Export package is missing manifest.json' }], warnings: [], preview: emptyPreview() }
  }

  const manifest: ExportManifest = JSON.parse(await manifestFile.async('string'))

  // 2. Version compatibility check
  const currentVersion = getCmsVersion()
  if (!isVersionCompatible(manifest.cmsVersion, currentVersion)) {
    warnings.push({
      code: 'VERSION_MISMATCH',
      message: `Export was created with CMS ${manifest.cmsVersion}, you are running ${currentVersion}. Some features may not import correctly.`
    })
  }

  // 3. Checksum verification
  const computedChecksum = await computeZipChecksum(zip)
  if (computedChecksum !== manifest.checksum) {
    errors.push({
      code: 'CHECKSUM_MISMATCH',
      message: 'Export package integrity check failed. The file may be corrupted.'
    })
  }

  // 4. Schema compatibility check per collection
  const collectionPreviews: ImportPreview['collections'] = {}

  for (const [collectionName, exportedSchema] of Object.entries(manifest.collections)) {
    const currentSchema = cms.schema.getCollection(collectionName)

    if (!currentSchema) {
      warnings.push({
        code: 'COLLECTION_NOT_FOUND',
        message: `Collection "${collectionName}" from export does not exist on this site. Its documents will be skipped.`,
        collection: collectionName,
      })
      continue
    }

    const schemaResult = checkSchemaCompatibility(exportedSchema.schema, currentSchema)
    errors.push(...schemaResult.errors.map(e => ({ ...e, collection: collectionName })))
    warnings.push(...schemaResult.warnings.map(w => ({ ...w, collection: collectionName })))

    // Count documents and detect conflicts
    const docFiles = Object.values(zip.files).filter(f =>
      f.name.startsWith(`collections/${collectionName}/`) && !f.dir
    )

    let newCount = 0
    let conflictCount = 0
    let incompatibleCount = schemaResult.errors.length > 0 ? docFiles.length : 0

    if (incompatibleCount === 0) {
      for (const file of docFiles) {
        const doc = JSON.parse(await file.async('string'))
        const exists = await cms.collections.exists(collectionName, doc.id)
        if (exists) conflictCount++
        else newCount++
      }
    }

    collectionPreviews[collectionName] = {
      total: docFiles.length,
      new: newCount,
      conflicts: conflictCount,
      incompatible: incompatibleCount,
    }
  }

  // 5. Media size check
  const mediaFiles = Object.values(zip.files).filter(f =>
    f.name.startsWith('media/files/') && !f.dir
  )
  const totalMediaSize = mediaFiles.reduce((sum, f) => sum + (f._data?.uncompressedSize ?? 0), 0)

  const preview: ImportPreview = {
    collections: collectionPreviews,
    media: {
      total: mediaFiles.length,
      totalSizeBytes: totalMediaSize,
      alreadyExists: 0, // checked during import phase
    },
    estimatedDurationMs: estimateImportDuration(manifest),
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    preview,
  }
}
```

---

### `src/importer/index.ts` — import orchestrator

```typescript
export async function runImport(
  zip: JSZip,
  options: ImportRunOptions,
  cms: CMSServices,
  onProgress: (progress: ImportProgress) => void
): Promise<ImportResult> {

  const result: ImportResult = {
    imported: {},
    skipped: {},
    warnings: [],
    errors: [],
  }

  // All database writes happen inside a transaction
  // If anything fails, everything is rolled back
  await cms.db.transaction(async (tx) => {

    // Phase 3: Import media files
    onProgress({ phase: 'media', step: 0, total: 0, message: 'Importing media files...' })
    const mediaIdMap = await importMedia(zip, cms, tx, onProgress)

    // Phase 4: Import documents
    onProgress({ phase: 'documents', step: 0, total: 0, message: 'Importing documents...' })
    const docIdMap = await importDocuments(zip, options, mediaIdMap, cms, tx, onProgress)

    // Phase 5: Resolve relations
    onProgress({ phase: 'relations', step: 0, total: 0, message: 'Resolving document relations...' })
    await resolveRelations(docIdMap, cms, tx)

    // Phase 6: Verify
    onProgress({ phase: 'verify', step: 0, total: 0, message: 'Verifying import...' })
    await verifyImport(zip, docIdMap, mediaIdMap, cms, tx, result)
  })

  return result
}
```

---

## API routes

### `POST /api/plugins/io/export`

Auth required. Super admin or admin role.

**Request body:**

```typescript
{
  collections: string[] | 'all'
  statusFilter: 'all' | 'published' | 'draft'
  includeMedia: boolean
  includeSettings: boolean
}
```

**Response:** Streams the ZIP file directly as a download.

```typescript
// The handler generates the ZIP and streams it
app.post('/export', requireAuth, requirePermission('content:read'), async (c) => {
  const options = await c.req.json<ExportOptions>()
  const zipBuffer = await runExport(options, cms)

  const filename = `export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`

  return new Response(zipBuffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': zipBuffer.length.toString(),
    }
  })
})
```

---

### `POST /api/plugins/io/import`

Two-step process:

**Step 1 — Validate and preview (dry run):**

```typescript
// Request: multipart/form-data with the ZIP file
// Query: ?validate=true

// Response:
{
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
  preview: ImportPreview
  uploadId: string    // temporary ID to reference this upload in step 2
}
```

**Step 2 — Run import:**

```typescript
// Request body:
{
  uploadId: string          // from step 1
  conflictStrategy: 'skip' | 'overwrite' | 'duplicate'
  collections: string[]     // which collections to import (can deselect)
  importMedia: boolean
  importSettings: boolean
}

// Response:
{
  jobId: string             // use this to poll /import/status/:jobId
}
```

---

### `GET /api/plugins/io/import/status/:jobId`

SSE stream for live import progress.

```typescript
// Events emitted:
{ event: 'progress', data: { phase: 'media', step: 4, total: 34, message: 'Importing media...' } }
{ event: 'progress', data: { phase: 'documents', step: 7, total: 17, message: 'Importing documents...' } }
{ event: 'complete', data: { imported: {...}, skipped: {...}, warnings: [...], duration: 4200 } }
{ event: 'error',    data: { message: 'Transaction rolled back: ...', phase: 'documents' } }
```

---

## Admin UI

### Export panel

Located at `Admin → Export / Import → Export`.

```
Export Content
──────────────

Collections to export
  ☑ Articles (12 documents)
  ☑ Pages (5 documents)
  ☑ Projects (3 documents)
  ─────────────
  ☑ Select all

Status filter
  ● All documents (published + drafts)
  ○ Published only
  ○ Drafts only

Include media files
  ● Yes — include all referenced images and documents
    Estimated ZIP size: ~24 MB
  ○ No — export content only (faster, smaller)

Include site settings
  ○ Yes — include site name, domain, theme settings
  ● No — skip settings (recommended for moving content between sites)

[Export now ↓]

──────────────

Last export: 3 days ago — export-2025-06-02.zip
[Download again]  [View export history]
```

The estimated ZIP size is calculated before export by summing media file sizes from the database. Shown to set expectations before a large export runs.

Clicking **Export now** triggers `POST /api/plugins/io/export` and the browser receives the ZIP as a download. A loading spinner shows while the ZIP is being generated. For large exports (many media files), the response may take 10-30 seconds — the UI shows a progress message.

---

### Import panel

Located at `Admin → Export / Import → Import`.

**Step 1 — Upload:**

```
Import Content
──────────────

Upload an export package (.zip)

  ┌──────────────────────────────────────────┐
  │                                          │
  │      Drag and drop your export ZIP       │
  │      or click to browse                  │
  │                                          │
  │      Accepts: .zip files only            │
  │                                          │
  └──────────────────────────────────────────┘

  ⚠ Importing will add or modify content on this site.
    Review the preview carefully before confirming.
```

**Step 2 — Validation and preview:**

After upload, validation runs automatically:

```
Export Package: export-2025-06-05.zip
Exported from: my-local-site.com on 5 Jun 2025
CMS version: 0.4.0 (compatible ✓)

Warnings:
  ⚠ Collection "case-study" from export does not exist here.
    Its 2 documents will be skipped.

What will be imported:

  Collection      Total    New    Conflicts    Action
  ─────────────────────────────────────────────────────
  Articles           12     10            2    skip conflicts
  Pages               5      3            2    skip conflicts
  Projects            3      3            0    —

  Media              34 files — 18.4 MB

  Conflict resolution
    ● Skip conflicts — keep existing content, only import new documents
    ○ Overwrite — replace existing documents with imported versions
    ○ Duplicate — import all as new documents (slugs get -2 suffix)

  Deselect collections to skip:
    ☑ Articles    ☑ Pages    ☑ Projects

  ☑ Import media files
  ☐ Import site settings

  [← Back]                    [Run import →]
```

**Step 3 — Live progress:**

```
Importing...

  ✓ Phase 1: Validated
  ✓ Phase 2: Preview confirmed
  ✓ Phase 3: Media          34/34 files imported
  ⟳ Phase 4: Documents      7/17 documents imported...
  ○ Phase 5: Relations
  ○ Phase 6: Verify

  Do not close this tab during import.
  [Cancel]  ← only available before Phase 4 begins
```

**Step 4 — Result:**

```
Import complete ✓

  Imported:
    Articles:  10 new documents
    Pages:      3 new documents
    Projects:   3 new documents
    Media:     34 files

  Skipped (conflicts):
    Articles:   2 (already existed, kept existing versions)
    Pages:      2 (already existed, kept existing versions)

  Skipped (missing collection):
    Case Studies: 2 (collection does not exist on this site)

  Warnings:
    ⚠ 1 relation could not be resolved — see details

  Duration: 4.2 seconds

  [View imported content →]    [Export report]
```

---

### Last Export dashboard widget

A small widget on the admin dashboard:

```
Last Export
──────────────────
3 days ago
export-2025-06-02.zip

[Export now]
```

Shows when the last export was done. Gentle reminder if it's been more than 7 days. Clicking **Export now** opens the export panel with defaults pre-filled.

---

## CLI commands

The plugin registers two CLI commands via the plugin's `setup()`:

```bash
# Export from command line — useful for scripting and CI
cms io:export [options]
  --collections article,page      Specific collections (default: all)
  --status published              Status filter (default: all)
  --no-media                      Skip media files
  --output ./backups/             Output directory (default: current directory)

# Example
cms io:export --status published --output ./backups/
# → Writes ./backups/export-2025-06-05-143022.zip

# Import from command line
cms io:import <file.zip> [options]
  --strategy skip                 Conflict strategy (default: skip)
  --collections article,page      Only import these collections
  --no-media                      Skip media import
  --yes                           Skip confirmation prompt

# Example
cms io:import ./backups/export-2025-06-05.zip --strategy overwrite
```

The CLI commands are especially useful for:
- Automated daily backups via cron: `0 2 * * * cms io:export --output /var/backups/cms/`
- CI/CD seeding: `cms io:import ./seed-content.zip --yes`
- Populating a new environment after `cms create`

---

## Scheduled exports (automatic backups)

The plugin registers a BullMQ job for scheduled exports:

```typescript
// In plugin setup()
jobs.register('io.scheduled-export', async () => {
  const options = await config.get<ScheduledExportConfig>('scheduledExport')
  if (!options?.enabled) return

  const zipBuffer = await runExport({
    collections: 'all',
    statusFilter: 'all',
    includeMedia: options.includeMedia ?? true,
    includeSettings: false,
  }, cms)

  // Save to configured backup location
  await saveBackup(zipBuffer, options.destination)

  // Clean up old backups beyond retention limit
  await pruneOldBackups(options.destination, options.retainCount ?? 30)
})

// Schedule: daily at 2am
jobs.enqueue('io.scheduled-export', {}, { repeat: { cron: '0 2 * * *' } })
```

Configuration in the plugin settings panel:

```
Scheduled Export
  Enable automatic exports: [toggle]
  Run at: [02:00] UTC
  Include media files: [toggle]
  Keep last N exports: [30]
  Save to: ● Local (/var/cms/backups/)
            ○ S3-compatible storage
              Endpoint: [          ]
              Bucket:   [          ]
              Key:      [          ]
              Secret:   [          ]
```

---

## Testing

### Unit tests

```typescript
// tests/export.test.ts
describe('Export', () => {
  test('exports all collections with correct structure', async () => { })
  test('respects status filter — published only', async () => { })
  test('respects status filter — draft only', async () => { })
  test('exports media records and files', async () => { })
  test('skips media files gracefully when files missing from disk', async () => { })
  test('generates valid manifest with correct checksums', async () => { })
  test('generates valid ZIP structure', async () => { })
  test('handles empty collections correctly', async () => { })
  test('handles collection with blocks() fields correctly', async () => { })
  test('handles collection with relation() fields correctly', async () => { })
})

// tests/import.test.ts
describe('Import', () => {
  test('validates manifest — missing manifest returns error', async () => { })
  test('validates manifest — checksum mismatch returns error', async () => { })
  test('validates schema — extra fields in export, warning returned', async () => { })
  test('validates schema — missing required field, error returned', async () => { })
  test('conflict strategy skip — existing docs not overwritten', async () => { })
  test('conflict strategy overwrite — existing docs replaced', async () => { })
  test('conflict strategy duplicate — new IDs assigned, slug suffixed', async () => { })
  test('import rolls back on failure — no partial data left', async () => { })
  test('unknown collection in export — skipped with warning', async () => { })
  test('media import — files written to correct paths', async () => { })
  test('relation resolution — internal relations resolved to new IDs', async () => { })
  test('relation resolution — unresolvable relation set to null with warning', async () => { })
})
```

### Round-trip test

The most important test — export then import should produce identical content:

```typescript
// tests/roundtrip.test.ts
describe('Round trip', () => {
  test('export then import produces identical documents', async () => {
    // 1. Create test content in a fresh database
    const originalDocs = await createTestContent()

    // 2. Export to ZIP
    const zip = await runExport({ collections: 'all', statusFilter: 'all', includeMedia: true, includeSettings: false }, cms)

    // 3. Clear the database
    await clearAllContent()

    // 4. Import from ZIP
    await runImport(zip, { conflictStrategy: 'overwrite', importMedia: true }, cms, () => {})

    // 5. Compare
    for (const originalDoc of originalDocs) {
      const importedDoc = await cms.collections.findOne(originalDoc.collection, { where: { id: originalDoc.id } })
      expect(importedDoc).toMatchObject(originalDoc)
    }
  })

  test('round trip preserves block structures exactly', async () => { })
  test('round trip preserves media file contents', async () => { })
  test('round trip preserves relation references', async () => { })
  test('round trip with status filter — only published docs round trip', async () => { })
})
```

---

## Done when

**Export:**
- Export panel renders with correct document counts per collection
- All three status filters produce correct output
- ZIP downloads immediately in the browser
- ZIP structure matches spec — manifest, collections/, media/ directories
- Manifest checksum is correct
- Large export (50+ documents, 100MB media) completes without timeout
- `cms io:export` CLI command works

**Import:**
- Upload accepts ZIP files only — other file types rejected
- Validation runs automatically after upload
- Preview shows correct new/conflict counts per collection
- All three conflict strategies behave correctly
- Import rolls back completely on any failure — no partial data
- Progress events stream correctly — admin shows live phase progress
- Relations resolved correctly for internal references
- Unresolvable relations set to null with warning, import continues
- Media files written to correct paths
- `cms io:import` CLI command works with `--yes` flag

**Round-trip:**
- Export then import on a fresh database produces identical content
- Blocks, relations, media all survive the round-trip correctly

**Scheduled export:**
- Plugin settings panel saves schedule config
- Scheduled job runs at configured time
- Old exports pruned beyond retention count
- S3-compatible destination works when configured

---

*`@kritano/cms-plugin-io` build task*
*Build before portfolio goes live — needed for local → production migration*
*Priority: High — pull forward from Phase 1.0*