import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { themeCssVariables } from '../theme-css-vars';
import { App } from './App';
import { initHandoff } from './auth/handoffRuntime';
import './styles.css';

const styleTag = document.createElement('style');
styleTag.textContent = themeCssVariables();
document.head.appendChild(styleTag);

// App -> shop sign-in handoff: read `#h=<code>` and strip it from the address
// bar BEFORE React mounts (so no screen renders for the old account while the
// code is redeemed, and the code never lingers in the URL/history). Also covers
// later `hashchange`s. See auth/handoffController.ts.
initHandoff();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
