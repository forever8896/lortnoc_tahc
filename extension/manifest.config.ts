import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'lortnoc tahc',
  version: '0.3.2',
  description: 'Type real, send cover text, decode inline — a stego overlay for Telegram Web.',
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'lortnoc tahc',
  },
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
  permissions: ['storage'],
  // The codec URL is user-set (local dev or a hosted HTTPS tunnel), so allow both.
  // Broad https is fine for an unpacked demo extension; tighten for any store release.
  host_permissions: ['http://localhost:8080/*', 'https://*/*'],
})
