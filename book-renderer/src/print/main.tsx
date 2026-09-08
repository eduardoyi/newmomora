import { createRoot } from 'react-dom/client';
import { themeCssVariables } from '../theme-css-vars';
import { PrintApp } from './PrintApp';
// Vendored print fonts (memory-book-5c plan, Step 2b) — Vite bundles this
// stylesheet's `url('./*.woff2')` references as content-hashed assets, same
// as any other imported CSS, so a production build (`npm run build`, what
// scripts/render-pdf.mts and the future render worker both serve) never
// depends on fonts.googleapis.com at render time. See fonts/OFL-LICENSES.txt
// for licensing and fonts/expectedFaces.ts for the hard-fail check PrintApp
// runs against these.
import './fonts/fonts.css';

// No StrictMode here (unlike src/preview/main.tsx): this entry renders
// exactly once per Puppeteer page load and is captured immediately once
// ready — StrictMode's dev-only double-effect-invoke has no upside for a
// single deterministic render and would only add noise to the "ready"
// signal timing.
const styleTag = document.createElement('style');
styleTag.textContent = themeCssVariables();
document.head.appendChild(styleTag);

createRoot(document.getElementById('root')!).render(<PrintApp />);
