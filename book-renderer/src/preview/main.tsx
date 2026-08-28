import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { themeCssVariables } from '../theme-css-vars';
import { App } from './App';
import './styles.css';

const styleTag = document.createElement('style');
styleTag.textContent = themeCssVariables();
document.head.appendChild(styleTag);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
