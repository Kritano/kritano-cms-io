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
    // Phase 3: Import system data
    const systemResult = await importSystemData(zip, sql, body.conflictStrategy || 'skip')
    result.warnings.push(...systemResult.warnings)
    if (systemResult.imported.users) result.imported['_users'] = systemResult.imported.users
    if (systemResult.imported.roles) result.imported['_roles'] = systemResult.imported.roles
    if (systemResult.imported.redirects) result.imported['_redirects'] = systemResult.imported.redirects
    if (systemResult.imported.webhooks) result.imported['_webhooks'] = systemResult.imported.webhooks
    if (systemResult.imported.forms) result.imported['_forms'] = systemResult.imported.forms
    if (systemResult.imported.mediaFolders) result.imported['_mediaFolders'] = systemResult.imported.mediaFolders
    if (systemResult.imported.siteSettings) result.imported['_siteSettings'] = systemResult.imported.siteSettings

  } catch (err) {
    result.errors.push(`Import failed: ${err instanceof Error ? err.message : err}`)
  }

  return c.json({
    success: result.errors.length === 0,
    ...result,
  })
}

async function importSystemData(
  zip: JSZip,
  sql: any,
  conflictStrategy: string,
): Promise<{ imported: Record<string, number>; warnings: string[] }> {
  const imported: Record<string, number> = {}
  const warnings: string[] = []

  async function loadJson(path: string): Promise<any[]> {
    const file = zip.file(path)
    if (!file) return []
    try { return JSON.parse(await file.async('string')) } catch { return [] }
  }

  // Import roles first (users reference roles)
  const roles = await loadJson('system/roles.json')
  let rolesImported = 0
  for (const role of roles) {
    try {
      await sql`INSERT INTO roles (id, name, permissions, created_at) VALUES (${role.id}, ${role.name}, ${sql.json(role.permissions)}, ${role.created_at || new Date().toISOString()}) ON CONFLICT (id) DO NOTHING`
      rolesImported++
    } catch (err) {
      // Try without ID (name conflict)
      try {
        await sql`INSERT INTO roles (name, permissions) VALUES (${role.name}, ${sql.json(role.permissions)}) ON CONFLICT (name) DO NOTHING`
        rolesImported++
      } catch {}
    }
  }
  if (rolesImported) imported.roles = rolesImported

  // Import users (without password hashes — they'll need to reset password or use OAuth)
  const users = await loadJson('system/users.json')
  let usersImported = 0
  for (const user of users) {
    try {
      const exists = await sql`SELECT id FROM users WHERE email = ${user.email} LIMIT 1`
      if (exists.length > 0) {
        if (conflictStrategy === 'overwrite') {
          await sql`UPDATE users SET name = ${user.name || null} WHERE email = ${user.email}`
          usersImported++
        } else {
          warnings.push(`User ${user.email} already exists — skipped`)
        }
      } else {
        // Import user with a temporary password hash (bcrypt hash of 'changeme')
        const tempHash = '$2a$10$rQEY9SaEhyWCsFCqV4MKNOqK9B8MJmC.pfXbPzkyR2XYL8qXnFyYi'
        await sql`INSERT INTO users (id, email, password_hash, name, created_at, updated_at) VALUES (${user.id}, ${user.email}, ${tempHash}, ${user.name || null}, ${user.created_at || new Date().toISOString()}, ${user.updated_at || new Date().toISOString()})`
        usersImported++
        warnings.push(`User ${user.email} imported with temporary password 'changeme' — must change on first login`)
      }
    } catch (err) {
      warnings.push(`Failed to import user ${user.email}: ${err}`)
    }
  }
  if (usersImported) imported.users = usersImported

  // Import user-role assignments
  const userRoles = await loadJson('system/user-roles.json')
  for (const ur of userRoles) {
    try {
      await sql`INSERT INTO user_roles (user_id, role_id) VALUES (${ur.user_id}, ${ur.role_id}) ON CONFLICT DO NOTHING`
    } catch {}
  }

  // Import site settings
  const settings = await loadJson('system/site-settings.json')
  let settingsImported = 0
  for (const setting of settings) {
    try {
      await sql`INSERT INTO site_settings (key, value) VALUES (${setting.key}, ${sql.json(setting.value)}) ON CONFLICT (key) DO UPDATE SET value = ${sql.json(setting.value)}`
      settingsImported++
    } catch {}
  }
  if (settingsImported) imported.siteSettings = settingsImported

  // Import redirects
  const redirects = await loadJson('system/redirects.json')
  let redirectsImported = 0
  for (const r of redirects) {
    try {
      await sql`INSERT INTO redirects (id, from_path, to_path, type, hits, created_at) VALUES (${r.id}, ${r.from_path}, ${r.to_path}, ${r.type || 301}, ${r.hits || 0}, ${r.created_at || new Date().toISOString()}) ON CONFLICT (id) DO NOTHING`
      redirectsImported++
    } catch {}
  }
  if (redirectsImported) imported.redirects = redirectsImported

  // Import webhooks (without secrets — they'll need reconfiguring)
  const webhooks = await loadJson('system/webhooks.json')
  let webhooksImported = 0
  for (const wh of webhooks) {
    try {
      await sql`INSERT INTO webhooks (id, name, url, events, active, created_at) VALUES (${wh.id}, ${wh.name}, ${wh.url}, ${sql.json(wh.events)}, ${wh.active ?? true}, ${wh.created_at || new Date().toISOString()}) ON CONFLICT (id) DO NOTHING`
      webhooksImported++
    } catch {}
  }
  if (webhooksImported) imported.webhooks = webhooksImported

  // Import media folders
  const folders = await loadJson('system/media-folders.json')
  let foldersImported = 0
  for (const f of folders) {
    try {
      await sql`INSERT INTO media_folders (id, name, parent_id, created_at) VALUES (${f.id}, ${f.name}, ${f.parent_id || null}, ${f.created_at || new Date().toISOString()}) ON CONFLICT (id) DO NOTHING`
      foldersImported++
    } catch {}
  }
  if (foldersImported) imported.mediaFolders = foldersImported

  // Import forms and form fields
  const forms = await loadJson('system/forms.json')
  let formsImported = 0
  for (const form of forms) {
    try {
      await sql`INSERT INTO forms (id, name, slug, settings, created_at) VALUES (${form.id}, ${form.name}, ${form.slug}, ${sql.json(form.settings || {})}, ${form.created_at || new Date().toISOString()}) ON CONFLICT (id) DO NOTHING`
      formsImported++
    } catch {}
  }
  if (formsImported) imported.forms = formsImported

  const formFields = await loadJson('system/form-fields.json')
  for (const ff of formFields) {
    try {
      await sql`INSERT INTO form_fields (id, form_id, type, label, name, required, options, sort_order) VALUES (${ff.id}, ${ff.form_id}, ${ff.type}, ${ff.label}, ${ff.name}, ${ff.required ?? false}, ${sql.json(ff.options || {})}, ${ff.sort_order || 0}) ON CONFLICT (id) DO NOTHING`
    } catch {}
  }

  return { imported, warnings }
}
