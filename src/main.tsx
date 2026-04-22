import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installStorePersistence } from './store/persistence';
import { PERFECT_STROKE_ENGINE_VERSION } from './application/drawing/perfectStroke';
import './styles.css';
import './styles/recording-reboot.css';

installStorePersistence();

if (typeof window !== 'undefined') {
  (window as Window & { __UNIFLOW_STROKE_ENGINE__?: string }).__UNIFLOW_STROKE_ENGINE__ = PERFECT_STROKE_ENGINE_VERSION;
}
if (typeof console !== 'undefined' && typeof console.warn === 'function') {
  console.warn(`[UniFlow] stroke-engine=${PERFECT_STROKE_ENGINE_VERSION}`);
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />);
