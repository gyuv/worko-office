import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { initTheme } from './lib/theme';
import { initPrefs } from './lib/prefs';
import './index.css';

initTheme();
initPrefs();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
