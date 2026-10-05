import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../print/fonts/fonts.css';
import { themeCssVariables } from '../../theme-css-vars';
import { CardPreviewApp } from './App';

// The book's CSS variables (--color-*, --lavender-*, --font-*): the book's editor CSS reads them.
const styleTag = document.createElement('style');
styleTag.textContent = themeCssVariables();
document.head.appendChild(styleTag);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CardPreviewApp />
  </StrictMode>,
);
