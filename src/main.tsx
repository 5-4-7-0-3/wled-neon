import { createRoot } from 'react-dom/client'
import { App } from './App'
import { desktop, windowed } from './platform'
import './styles.css'

if (desktop) document.documentElement.classList.add('desktop')
if (windowed) document.documentElement.classList.add('windowed')

createRoot(document.getElementById('root')!).render(<App />)
