import JSZip from 'jszip'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface ImportValidationResult {
  valid: boolean
  errors: Array<{ code: string; message: string }>
  warnings: Array<{ code: string; message: string }>
  preview: {
    collections: Record<string, { total: number; new: number; conflicts: number }>
    media: { total: number; totalSizeBytes: number }
  }
  manifest: any
}

export interface ImportRunOptions {
  conflictStrategy: 'skip' | 'overwrite' | 'duplicate'
  collections?: string[]
  importMedia: boolean
}

// In-memory store for uploaded ZIPs awaiting import
const pendingUploads = new Map<string, { zip: JSZip; manifest: any; validatedAt: number }>()

// Clean up old pending uploads every 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of pendingUploads) {
    if (now - entry.validatedAt > 30 * 60 * 1000) pendingUploads.delete(id)
  }
}, 10 * 60 * 1000)

export async function handleImportValidate(c: any): Promise<Response> {
  const formData = await c.req.formData()
  const file = formData.get('file') as File

  if (!file) {
    return c.json({ valid: false, errors: [{ code: 'NO_FILE', message: 'No file uploaded' }], warnings: [], preview: null }, 400)
  }

  if (!file.name.endsWith('.zip')) {
    return c.json({ valid: false, errors: [{ code: 'INVALID_TYPE', message: 'Only .zip files are accepted' }], warnings: [], preview: null }, 400)
  }

  const buffer = await file.arrayBuffer()
  const zip = await JSZip.loadAsync(buffer)

  // Read manifest
  const manifestFile = zip.file('manifest.json')
  if (!manifestFile) {
    return c.json({ valid: false, errors: [{ code: 'MISSING_MANIFEST', message: 'Export package is missing manifest.json' }], warnings: [], preview: null }, 400)
  }

  const manifest = JSON.parse(await manifestFile.async('string'))
  const errors: Array<{ code: string; message: string }> = []
  const warnings: Array<{ code: string; message: string }> = []

  // Version check
  if (manifest.cmsVersion && manifest.cmsVersion !== '0.4.0') {
    warnings.push({ code: 'VERSION_MISMATCH', message: `Export from CMS ${manifest.cmsVersion}, current is 0.4.0` })
  }

  // Check collections exist on target
  const { getClient, collectionToTableName } = await import('@kritano/cms/core')
  const sql = getClient()

  const preview: Record<string, { total: number; new: number; conflicts: number }> = {}

  for (const [collectionName, info] of Object.entries(manifest.collections as Record<string, any>)) {
    const tableName = collectionToTableName(collectionName)

    try {
      // Check table exists
      await sql.unsafe(`SELECT 1 FROM "${tableName}" LIMIT 0`)

      // Count existing docs
      const docFiles = Object.keys(zip.files).filter(
        (f) => f.startsWith(`collections/${collectionName}/`) && f.endsWith('.json'),
      )

      let newCount = 0
      let conflictCount = 0

      for (const filePath of docFiles) {
        const content = await zip.file(filePath)!.async('string')
        const doc = JSON.parse(content)
        const existing = await sql.unsafe(`SELECT id FROM "${tableName}" WHERE id = $1 LIMIT 1`, [doc.id])
        if (existing.length > 0) conflictCount++
        else newCount++
      }

      preview[collectionName] = { total: info.count, new: newCount, conflicts: conflictCount }
    } catch {
      warnings.push({ code: 'COLLECTION_NOT_FOUND', message: `Collection "${collectionName}" does not exist on this site` })
      preview[collectionName] = { total: info.count, new: 0, conflicts: 0 }
    }
  }

  // Count media files
  const mediaFiles = Object.keys(zip.files).filter((f) => f.startsWith('media/files/') && !zip.files[f].dir)
  let totalMediaSize = 0
  for (const f of mediaFiles) {
    const data = await zip.file(f)!.async('nodebuffer')
    totalMediaSize += data.length
  }

  // Store for later use
  const uploadId = crypto.randomUUID()
  pendingUploads.set(uploadId, { zip, manifest, validatedAt: Date.now() })

  return c.json({
    valid: errors.length === 0,
    errors,
    warnings,
    preview: {
      collections: preview,
      media: { total: mediaFiles.length, totalSizeBytes: totalMediaSize },
    },
    manifest,
    uploadId,
  })
}

export async function handleImportRun(c: any): Promise<Response> {
  const body = await c.req.json<ImportRunOptions & { uploadId: string }>()

  const pending = pendingUploads.get(body.uploadId)
  if (!pending) {
    return c.json({ error: { code: 'UPLOAD_NOT_FOUND', message: 'Upload expired or not found. Please re-upload.' } }, 400)
  }

  const { zip, manifest } = pending
  pendingUploads.delete(body.uploadId)

  const { getClient, collectionToTableName, fieldToColumnName } = await import('@kritano/cms/core')
  const sql = getClient()

  const result = {
    imported: {} as Record<string, number>,
    skipped: {} as Record<string, number>,
    mediaImported: 0,
    warnings: [] as string[],
    errors: [] as string[],
  }

  try {
    // Phase 1: Import media
    if (body.importMedia) {
      const mediaRecordsFile = zip.file('media/records.json')
      if (mediaRecordsFile) {
        const records = JSON.parse(await mediaRecordsFile.async('string'))
        const mediaPath = process.env.MEDIA_PATH || './media'
        await mkdir(mediaPath, { recursive: true })

        for (const record of records) {
          // Write file to disk
          const fileEntry = zip.file(`media/files/${record.filename}`)
          if (fileEntry) {
            const buffer = await fileEntry.async('nodebuffer')
            await writeFile(join(mediaPath, record.filename), buffer)
            result.mediaImported++
          }

          // Also write WebP if present
          const webpFilename = record.filename.replace(/\.[^.]+$/, '.webp')
          const webpEntry = zip.file(`media/files/${webpFilename}`)
          if (webpEntry) {
            const buffer = await webpEntry.async('nodebuffer')
            await writeFile(join(mediaPath, webpFilename), buffer)
          }

          // Insert media record
          try {
            await sql`
              INSERT INTO media (id, filename, original_filename, mime_type, size, width, height, alt, folder_id, created_at)
              VALUES (${record.id}, ${record.filename}, ${record.original_filename || record.filename}, ${record.mime_type}, ${record.size || 0}, ${record.width ?? null}, ${record.height ?? null}, ${record.alt || ''}, ${record.folder_id ?? null}, ${record.created_at || new Date().toISOString()})
              ON CONFLICT (id) DO NOTHING
            `
          } catch (err) {
            result.warnings.push(`Failed to insert media record ${record.id}: ${err}`)
          }
        }
      }
    }

    // Phase 2: Import documents
    const collectionsToImport = body.collections ?? Object.keys(manifest.collections)

    for (const collectionName of collectionsToImport) {
      const tableName = collectionToTableName(collectionName)
      let imported = 0
      let skipped = 0

      // Check table exists
      try {
        await sql.unsafe(`SELECT 1 FROM "${tableName}" LIMIT 0`)
      } catch {
        result.warnings.push(`Collection "${collectionName}" does not exist — skipped`)
        result.skipped[collectionName] = (manifest.collections[collectionName]?.count ?? 0)
        continue
      }

      // Get document files for this collection
      const docFiles = Object.keys(zip.files).filter(
        (f) => f.startsWith(`collections/${collectionName}/`) && f.endsWith('.json'),
      )

      for (const filePath of docFiles) {
        const content = await zip.file(filePath)!.async('string')
        const doc = JSON.parse(content)
        const fields = doc.fields || doc

        // Check for conflict
        const existing = await sql.unsafe(`SELECT id FROM "${tableName}" WHERE id = $1 LIMIT 1`, [doc.id || fields.id])

        if (existing.length > 0) {
          if (body.conflictStrategy === 'skip') {
            skipped++
            continue
          } else if (body.conflictStrategy === 'overwrite') {
            await sql.unsafe(`DELETE FROM "${tableName}" WHERE id = $1`, [doc.id || fields.id])
          } else if (body.conflictStrategy === 'duplicate') {
            // Generate new ID, suffix the slug
            fields.id = crypto.randomUUID()
            if (fields.slug) fields.slug = `${fields.slug}-${Date.now()}`
          }
        }

        // Insert document
        try {
          const keys = Object.keys(fields).filter((k) => k !== 'collection')
          const values = keys.map((k) => fields[k])

          // Convert keys to snake_case for column names
          const columns = keys.map((k) => {
            // Common mappings
            if (k === 'createdAt' || k === 'created_at') return 'created_at'
            if (k === 'updatedAt' || k === 'updated_at') return 'updated_at'
            if (k === 'publishedAt' || k === 'published_at') return 'published_at'
            return k.replace(/([A-Z])/g, '_$1').toLowerCase()
          })

          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
          const colStr = columns.map((c) => `"${c}"`).join(', ')

          await sql.unsafe(
            `INSERT INTO "${tableName}" (${colStr}) VALUES (${placeholders})`,
            values as any[],
          )
          imported++
        } catch (err) {
          result.warnings.push(`Failed to import document in ${collectionName}: ${err}`)
        }
      }

      result.imported[collectionName] = imported
      if (skipped > 0) result.skipped[collectionName] = skipped
    }
  } catch (err) {
    result.errors.push(`Import failed: ${err instanceof Error ? err.message : err}`)
  }

  return c.json({
    success: result.errors.length === 0,
    ...result,
  })
}
