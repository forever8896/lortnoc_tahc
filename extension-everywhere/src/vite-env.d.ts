/// <reference types="vite/client" />
declare module '*?script' {
  const path: string
  export default path
}

// content/icons.ts: a raw import with its own query, so it never shares a chunk with the pages
declare module '*.svg?raw&content' {
  const src: string
  export default src
}
