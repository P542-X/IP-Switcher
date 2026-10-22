import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Nota: React.StrictMode está desactivado a propósito.
// En dev hace que todos los componentes rendericen el doble para detectar bugs,
// lo que causa micro-freezes al cambiar de foco entre inputs en una app Electron.
// Si quieres reactivarlo temporalmente para detectar bugs, envuelve <App /> con <React.StrictMode>.
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
