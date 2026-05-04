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

async function exportSystemData(sql: any): Promise<Record<string, any[]>> {
  const system: Record<string, any[]> = {}

  // Users (excluding password hashes for security — import will require password reset)
  try {
    const users = await sql`SELECT id, email, name, two_factor_enabled, created_at, updated_at FROM users`
    system.users = users as any[]
  } catch { system.users = [] }

  // Roles
  try {
    const roles = await sql`SELECT * FROM roles`
    system.roles = roles as any[]
  } catch { system.roles = [] }

  // User-role assignments
  try {
    const userRoles = await sql`SELECT * FROM user_roles`
    system.userRoles = userRoles as any[]
  } catch { system.userRoles = [] }

  // Site settings
  try {
    const settings = await sql`SELECT * FROM site_settings`
    system.siteSettings = settings as any[]
  } catch { system.siteSettings = [] }

  // Redirects
  try {
    const redirects = await sql`SELECT * FROM redirects`
    system.redirects = redirects as any[]
  } catch { system.redirects = [] }

  // Webhooks
  try {
    const webhooks = await sql`SELECT id, name, url, events, active, created_at FROM webhooks`
    system.webhooks = webhooks as any[]
  } catch { system.webhooks = [] }

  // Forms and form fields
  try {
    const forms = await sql`SELECT * FROM forms`
    system.forms = forms as any[]
  } catch { system.forms = [] }

  try {
    const formFields = await sql`SELECT * FROM form_fields`
    system.formFields = formFields as any[]
  } catch { system.formFields = [] }

  // Media folders
  try {
    const folders = await sql`SELECT * FROM media_folders`
    system.mediaFolders = folders as any[]
  } catch { system.mediaFolders = [] }

  return system
}

export async function handleExport(c: any): Promise<Response> {
  const body = await c.req.json<ExportOptions>()
  const options: ExportOptions = {
    collections: body.collections ?? 'all',
    statusFilter: body.statusFilter ?? 'all',
    includeMedia: body.includeMedia ?? true,
    includeSettings: body.includeSettings ?? true,
  }

  const { getClient } = await import('@kritano/cms/core')
  const sql = getClient()
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

  // 3. Export system data (users, roles, settings, redirects, webhooks, forms, folders)
  const systemData = await exportSystemData(sql)
  zip.file('system/users.json', JSON.stringify(systemData.users, null, 2))
  zip.file('system/roles.json', JSON.stringify(systemData.roles, null, 2))
  zip.file('system/user-roles.json', JSON.stringify(systemData.userRoles, null, 2))
  zip.file('system/site-settings.json', JSON.stringify(systemData.siteSettings, null, 2))
  zip.file('system/redirects.json', JSON.stringify(systemData.redirects, null, 2))
  zip.file('system/webhooks.json', JSON.stringify(systemData.webhooks, null, 2))
  zip.file('system/forms.json', JSON.stringify(systemData.forms, null, 2))
  zip.file('system/form-fields.json', JSON.stringify(systemData.formFields, null, 2))
  zip.file('system/media-folders.json', JSON.stringify(systemData.mediaFolders, null, 2))

  // 4. Generate manifest
  const docCounts: Record<string, { count: number; schema: any }> = {}
  for (const [name, docs] of Object.entries(documents)) {
    docCounts[name] = { count: docs.length, schema: collectionSchemas[name] ?? {} }
  }

  const hash = createHash('sha256')
  for (const [, docs] of Object.entries(documents)) {
    for (const doc of docs) {
      hash.update(JSON.stringify(doc))
    }
  }
  const checksum = `sha256:${hash.digest('hex')}`

  const manifest = {
    version: '1.1',
    cmsVersion: '0.4.0',
    exportedAt: new Date().toISOString(),
    exportedFrom: process.env.SITE_URL || 'http://localhost:3006',
    collections: docCounts,
    media: { count: mediaCount, totalSizeBytes: mediaTotalSize },
    system: {
      users: systemData.users.length,
      roles: systemData.roles.length,
      redirects: systemData.redirects.length,
      webhooks: systemData.webhooks.length,
      forms: systemData.forms.length,
      mediaFolders: systemData.mediaFolders.length,
    },
    options,
    checksum,
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2))

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
