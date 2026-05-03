import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { exportCollections } from './collections'
import { exportMedia } from './media'

export interface ExportOptions {
  collections: string[] | 'all'
  statusFilter: 'all' | 'published' | 'draft'
  includeMedia: boolean
  includeSettings: boolean
}

export async function handleExport(c: any): Promise<Response> {
  const body = await c.req.json<ExportOptions>()
  const options: ExportOptions = {
    collections: body.collections ?? 'all',
    statusFilter: body.statusFilter ?? 'all',
    includeMedia: body.includeMedia ?? true,
    includeSettings: body.includeSettings ?? false,
  }

  const zip = new JSZip()

  // 1. Export collections
  const { documents, collectionSchemas } = await exportCollections(options)

  for (const [collection, docs] of Object.entries(documents)) {
    for (const doc of docs) {
      zip.file(
        `collections/${collection}/${doc.id}.json`,
        JSON.stringify(doc, null, 2),
      )
    }
  }

  // 2. Export media
  let mediaCount = 0
  let mediaTotalSize = 0

  if (options.includeMedia) {
    const { records, files } = await exportMedia(documents)
    zip.file('media/records.json', JSON.stringify(records, null, 2))
    for (const [filename, buffer] of Object.entries(files)) {
      zip.file(`media/files/${filename}`, buffer)
    }
    mediaCount = records.length
    mediaTotalSize = Object.values(files).reduce((sum, buf) => sum + buf.length, 0)
  }

  // 3. Export settings
  if (options.includeSettings) {
    try {
      const { getClient } = await import('@kritano/cms/core')
      const sql = getClient()
      const rows = await sql`SELECT key, value FROM site_settings`
      const settings: Record<string, unknown> = {}
      for (const row of rows) {
        const r = row as Record<string, unknown>
        settings[r.key as string] = r.value
      }
      zip.file('settings.json', JSON.stringify(settings, null, 2))
    } catch {}
  }

  // 4. Generate manifest
  const docCounts: Record<string, { count: number; schema: any }> = {}
  for (const [name, docs] of Object.entries(documents)) {
    docCounts[name] = { count: docs.length, schema: collectionSchemas[name] ?? {} }
  }

  // Compute checksum of all content
  const hash = createHash('sha256')
  for (const [, docs] of Object.entries(documents)) {
    for (const doc of docs) {
      hash.update(JSON.stringify(doc))
    }
  }
  const checksum = `sha256:${hash.digest('hex')}`

  const manifest = {
    version: '1.0',
    cmsVersion: '0.4.0',
    exportedAt: new Date().toISOString(),
    exportedFrom: process.env.SITE_URL || 'http://localhost:3006',
    collections: docCounts,
    media: { count: mediaCount, totalSizeBytes: mediaTotalSize },
    options,
    checksum,
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2))

  // 5. Generate ZIP
  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })

  const filename = `export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`

  return new Response(zipBuffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(zipBuffer.length),
    },
  })
}
