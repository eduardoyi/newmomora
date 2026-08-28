import { createRoot } from 'react-dom/client';
import { themeCssVariables } from '../theme-css-vars';
import { PrintApp } from './PrintApp';

// No StrictMode here (unlike src/preview/main.tsx): this entry renders
// exactly once per Puppeteer page load and is captured immediately once
// ready — StrictMode's dev-only double-effect-invoke has no upside for a
// single deterministic render and would only add noise to the "ready"
// signal timing.
const styleTag = document.createElement('style');
styleTag.textContent = themeCssVariables();
document.head.appendChild(styleTag);

createRoot(document.getElementById('root')!).render(<PrintApp />);
