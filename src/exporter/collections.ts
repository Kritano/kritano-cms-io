import type { ExportOptions } from './index'

export interface ExportedDocument {
  id: string
  collection: string
  status: string
  created_at: string
  updated_at: string
  published_at: string | null
  fields: Record<string, unknown>
}

export async function exportCollections(options: ExportOptions): Promise<{
  documents: Record<string, ExportedDocument[]>
  collectionSchemas: Record<string, any>
}> {
  const { getClient, collectionToTableName } = await import('@kritano/cms/core')
  const sql = getClient()

  // Get all collection names from the schema API
  let collectionNames: string[]
  const collectionSchemas: Record<string, any> = {}

  try {
    // Read config to get collection names and schemas
    const { resolve } = await import('node:path')
    const configPath = resolve(process.cwd(), 'cms.config')
    const { default: config } = await import(configPath)

    if (options.collections === 'all') {
      collectionNames = config.collections.map((c: any) => c.name)
    } else {
      collectionNames = options.collections
    }

    for (const col of config.collections) {
      collectionSchemas[col.name] = { fields: col.fields }
    }
  } catch {
    // Fallback: just use the provided collection names
    collectionNames = options.collections === 'all' ? [] : options.collections
  }

  const documents: Record<string, ExportedDocument[]> = {}

  for (const collectionName of collectionNames) {
    const tableName = collectionToTableName(collectionName)

    let query = `SELECT * FROM "${tableName}"`
    const params: unknown[] = []

    if (options.statusFilter !== 'all') {
      query += ` WHERE status = $1`
      params.push(options.statusFilter)
    }

    query += ` ORDER BY created_at ASC`

    try {
      const rows = await sql.unsafe(query, params)
      documents[collectionName] = rows.map((row: any) => ({
        id: row.id,
        collection: collectionName,
        status: row.status || 'draft',
        created_at: row.created_at,
        updated_at: row.updated_at,
        published_at: row.published_at ?? null,
        fields: row,
      }))
    } catch (err) {
      console.warn(`[io-plugin] Failed to export collection "${collectionName}": ${err}`)
      documents[collectionName] = []
    }
  }

  return { documents, collectionSchemas }
}
