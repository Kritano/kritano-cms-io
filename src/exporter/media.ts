import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExportedDocument } from './collections'

export interface ExportedMediaRecord {
  id: string
  original_filename: string
  filename: string
  mime_type: string
  size: number
  width: number | null
  height: number | null
  alt: string
  folder_id: string | null
  created_at: string
}

export async function exportMedia(
  documents: Record<string, ExportedDocument[]>,
): Promise<{ records: ExportedMediaRecord[]; files: Record<string, Buffer> }> {
  const { getClient } = await import('@kritano/cms/core')
  const sql = getClient()

  // Collect all media IDs referenced in documents
  const mediaIds = new Set<string>()

  for (const docs of Object.values(documents)) {
    for (const doc of docs) {
      collectMediaIds(doc.fields, mediaIds)
    }
  }

  if (mediaIds.size === 0) {
    return { records: [], files: {} }
  }

  // Fetch media records from database
  const idArray = Array.from(mediaIds)
  const records: ExportedMediaRecord[] = []
  const files: Record<string, Buffer> = {}

  try {
    const rows = await sql`SELECT * FROM media WHERE id = ANY(${idArray})`

    for (const row of rows) {
      const r = row as Record<string, unknown>
      records.push({
        id: r.id as string,
        original_filename: (r.original_filename || r.filename) as string,
        filename: r.filename as string,
        mime_type: r.mime_type as string,
        size: (r.size as number) || 0,
        width: (r.width as number) ?? null,
        height: (r.height as number) ?? null,
        alt: (r.alt as string) || '',
        folder_id: (r.folder_id as string) ?? null,
        created_at: r.created_at as string,
      })

      // Read actual file from disk
      const mediaPath = process.env.MEDIA_PATH || './media'
      const filename = r.filename as string

      try {
        files[filename] = await readFile(join(mediaPath, filename))

        // Also try to read WebP version
        const webpFilename = filename.replace(/\.[^.]+$/, '.webp')
        try {
          files[webpFilename] = await readFile(join(mediaPath, webpFilename))
        } catch {}

        // Also try thumbnail
        const thumbFilename = filename.replace(/(\.[^.]+)$/, '-thumb$1')
        try {
          files[thumbFilename] = await readFile(join(mediaPath, thumbFilename))
        } catch {}
      } catch {
        console.warn(`[io-plugin] Could not read media file: ${filename}`)
      }
    }
  } catch (err) {
    console.warn(`[io-plugin] Failed to query media: ${err}`)
  }

  return { records, files }
}

function collectMediaIds(obj: unknown, ids: Set<string>): void {
  if (!obj || typeof obj !== 'object') return

  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectMediaIds(item, ids)
    }
    return
  }

  const record = obj as Record<string, unknown>

  // Check if this looks like a UUID media reference
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && isUuid(value) && isMediaField(key)) {
      ids.add(value)
    } else if (typeof value === 'object') {
      collectMediaIds(value, ids)
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function isMediaField(name: string): boolean {
  const mediaFieldNames = ['image', 'images', 'photo', 'avatar', 'media', 'featured_image', 'featuredImage', 'thumbnail', 'cover']
  return mediaFieldNames.some((f) => name.toLowerCase().includes(f.toLowerCase()))
}
