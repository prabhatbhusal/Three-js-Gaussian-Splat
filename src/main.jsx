import { createRoot } from 'react-dom/client';
import App from './App.jsx';

// NO StrictMode. LCCRender is a module-level singleton — React's dev-mode
// double-mount calls load() twice, gets the same instance back, then the first
// cleanup disposes the live renderer. Black screen, dev only, miserable to trace.
createRoot(document.getElementById('root')).render(<App />);
