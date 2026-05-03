import { definePlugin } from '@kritano/cms/core'
import { handleExport } from './exporter'
import { handleImportValidate, handleImportRun } from './importer'

export default definePlugin({
  name: '@kritano/cms-plugin-io',
  version: '1.0.0',
  description: 'Export and import content between CMS instances',
  author: 'Kritano',
  trust: 'trusted',
  cms: { minVersion: '0.3.0' },

  setup(context) {
    // Export endpoint — returns ZIP download
    context.api.post('/export', async (c: any) => {
      return handleExport(c)
    })

    // Import step 1 — validate and preview
    context.api.post('/import/validate', async (c: any) => {
      return handleImportValidate(c)
    })

    // Import step 2 — run import
    context.api.post('/import/run', async (c: any) => {
      return handleImportRun(c)
    })

    // Admin section
    context.admin.registerSection({
      label: 'Export / Import',
      icon: 'arrow-left-right',
      path: '/admin/io',
    })

    // Store last export timestamp
    context.hooks.on('cms.ready', async () => {
      const lastExport = await context.storage.get('lastExportAt')
      if (!lastExport) {
        await context.storage.set('lastExportAt', null)
      }
    })
  },
})
