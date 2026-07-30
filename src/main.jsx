import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

// NO StrictMode — LCCRender is a module singleton, and React's dev double-mount
// disposes the live renderer.
createRoot(document.getElementById('root')).render(<App />);