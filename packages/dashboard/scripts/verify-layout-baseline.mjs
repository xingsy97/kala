/**
 * Baseline layout theme verification. Not tied to any feature — proves the
 * standard 5 layout regions (workbench, toolbar, chat, explorer, inspector)
 * respond to the theme class.
 *
 * If this script exits 0, either the app is correctly themed or the harness is
 * lying. If it exits non-zero, the failure lines name exactly which container
 * ignores the theme.
 *
 * Runs against http://localhost:3000 by default; host must be up.
 */

import {
  STANDARD_LAYOUT_REGIONS,
  launchDashboard,
  verifyAcrossThemes,
} from './verify-lib.mjs'

const url = process.env.AK_DASHBOARD_URL ?? 'http://localhost:3000'

const { browser, page, errors } = await launchDashboard({ url })

let exitCode = 0
try {
  await verifyAcrossThemes(page, {
    name: 'ak-layout-baseline',
    regions: STANDARD_LAYOUT_REGIONS,
    requireTextColorDiffOn: 'workbench-toolbar',
  })
} catch (err) {
  exitCode = 1
  if (!err.failures) console.error(err)
} finally {
  if (errors.length > 0) {
    console.error('\npage errors during run:')
    for (const e of errors) console.error(`  ${e}`)
  }
  await browser.close()
}

process.exit(exitCode)
