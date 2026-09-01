/**
 * Main Entry Point
 *
 * This is where React mounts to the DOM.
 *
 * Provider order matters: ToastProvider wraps AuthProvider so that auth
 * itself can raise a toast later (a dropped socket, a failed session
 * refresh) without a circular dependency between the two contexts.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from './context/AuthContext'
import { ToastProvider } from './components/Toast'
import './styles/tokens.css'
import './styles/base.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ToastProvider>
  </StrictMode>,
)
