import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { BackendProvider } from './lib/ctx'
import { App } from './app'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BackendProvider>
      <App />
    </BackendProvider>
  </StrictMode>,
)
