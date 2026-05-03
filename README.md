# @kritano/cms-plugin-io

Export and import content between [Kritano CMS](https://github.com/Kritano/Kritano-cms) instances.

## What it does

- **Export** all content (documents, media, settings) as a single ZIP file
- **Import** content from a ZIP into any CMS instance
- **Conflict resolution** — skip, overwrite, or duplicate on import
- Filter by collection and status (published/draft)

## Install

### As a local plugin (development)

Drop this repo in your project's `plugins/` directory:

```bash
cd my-site
git clone https://github.com/Kritano/kritano-cms-io.git plugins/io
```

Local plugins are auto-discovered — no config changes needed.

### As a dependency

```bash
bun add github:Kritano/kritano-cms-io
```

Then add to `cms.config.ts`:

```typescript
export default defineConfig({
  plugins: [
    '@kritano/cms-plugin-io',
  ],
})
```

## Usage

After installing, an **Export / Import** section appears in the admin sidebar.

### Export

1. Go to Admin → Export / Import
2. Select collections, status filter, media options
3. Click Export — downloads a ZIP

### Import

1. Go to Admin → Export / Import
2. Upload a ZIP file
3. Review the preview (what will be imported, conflicts)
4. Choose conflict strategy (skip/overwrite/duplicate)
5. Click Import

### API

```
POST /api/plugins/@kritano/cms-plugin-io/export
POST /api/plugins/@kritano/cms-plugin-io/import/validate
POST /api/plugins/@kritano/cms-plugin-io/import/run
```

## Export format

The ZIP contains:

```
export.zip
├── manifest.json          — metadata, checksums, schema snapshot
├── collections/
│   ├── article/
│   │   ├── uuid-1.json
│   │   └── uuid-2.json
│   └── page/
│       └── uuid-3.json
├── media/
│   ├── records.json       — media metadata
│   └── files/
│       ├── image.jpg
│       └── image.webp
└── settings.json          — site config (optional)
```

## Licence

MIT
