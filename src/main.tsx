import { createRoot } from 'react-dom/client'
import { App } from './App'
import { desktop } from './platform'
import './styles.css'

if (desktop) document.documentElement.classList.add('desktop')

createRoot(document.getElementById('root')!).render(<App />)
