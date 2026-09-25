import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

// PERMISSIONS ARE THE PRODUCT'S PRIVACY STORY (docs/PRD-universal.md §13.4):
//   * NO host permission for web pages at install. The keyboard shortcut and the right-click
//     "Reveal" each grant activeTab for that one tab, which is all encode and reveal need.
//   * The only standing host permissions are the codec (localhost for dev, the hosted instance).
//   * The sheet and the reveal card run as EXTENSION-ORIGIN iframes, so the page's own scripts
//     cannot read what you type or what gets revealed — plaintext never enters the page's DOM.
export default defineManifest({
  manifest_version: 3,
  name: 'lortnoc tahc — everywhere',
  version: pkg.version,
  description: 'Write everywhere; only the people you choose can read it. Everyone else sees chatter.',
  icons: { 16: 'icons/on-16.png', 32: 'icons/on-32.png', 48: 'icons/on-48.png', 128: 'icons/on-128.png' },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'lortnoc tahc — everywhere',
    default_icon: { 16: 'icons/on-16.png', 32: 'icons/on-32.png', 48: 'icons/on-48.png', 128: 'icons/on-128.png' },
  },
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  commands: {
    compose: {
      suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' },
      description: 'Write a hidden message into the focused text box',
    },
  },
  permissions: ['storage', 'activeTab', 'scripting', 'contextMenus'],
  host_permissions: ['http://localhost/*', 'http://127.0.0.1/*', 'https://lortnoc-codec.fly.dev/*'],
  web_accessible_resources: [
    { resources: ['src/sheet/index.html', 'src/reveal/index.html', 'assets/*', 'icons/*', 'fonts/*'], matches: ['<all_urls>'] },
  ],
})
