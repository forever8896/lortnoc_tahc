import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'lortnoc tahc',
  version: '0.4.2',
  description: 'Type real, send cover text, decode inline — a stego overlay for Telegram Web.',
  icons: {
    16: 'icons/on-16.png',
    32: 'icons/on-32.png',
    48: 'icons/on-48.png',
    128: 'icons/on-128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'lortnoc tahc — stego for Telegram',
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
      // Web K is the supported client; Web A matched for graceful "unsupported" messaging.
      matches: ['https://web.telegram.org/k/*', 'https://web.telegram.org/a/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage', 'scripting'],
  // The codec URL is user-set (local dev or a hosted HTTPS tunnel), so allow both.
  // Broad https is fine for an unpacked demo extension; tighten for any store release.
  host_permissions: ['http://localhost:8080/*', 'https://*/*'],
})
