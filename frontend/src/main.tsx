import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/source-sans-pro/300.css'
import '@fontsource/source-sans-pro/300-italic.css'
import '@fontsource/source-sans-pro/600.css'
import '@fontsource/source-sans-pro/600-italic.css'
import './template/assets/css/main.css'
import './app.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
