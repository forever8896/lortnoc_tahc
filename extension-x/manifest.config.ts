import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

export default defineManifest({
  manifest_version: 3,
  name: 'lortnoc tahc for X',
  // ONE version, read from package.json — Chrome reads THIS to decide whether an install is an
  // update, so a hardcoded copy here ships fixes no existing user is ever offered.
  version: pkg.version,
  description: 'Type real, post cover text, decode inline — a stego overlay for X.',
  icons: {
    16: 'icons/on-16.png',
    32: 'icons/on-32.png',
    48: 'icons/on-48.png',
    128: 'icons/on-128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'lortnoc tahc — stego for X',
    default_icon: {
      16: 'icons/off-16.png',
      32: 'icons/off-32.png',
      48: 'icons/off-48.png',
      128: 'icons/off-128.png',
    },
  },
  web_accessible_resources: [
    { resources: ['icons/*', 'fonts/*', 'logo.png'], matches: ['<all_urls>'] },
  ],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      // twitter.com still redirects to x.com for most routes, but the old host is matched so a
      // stale link or an un-migrated surface does not silently drop the overlay.
      matches: ['https://x.com/*', 'https://twitter.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage'],
  // The codec URL is user-settable (hosted default, or localhost for dev), so allow both.
  // Broad https is fine for an unpacked demo build; tighten before any store release.
  host_permissions: ['http://localhost:8080/*', 'https://*/*'],
})
