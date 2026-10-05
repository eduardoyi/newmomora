import { createRoot } from 'react-dom/client';
import '../../print/fonts/fonts.css';
import { CardPrintApp } from './CardPrintApp';

createRoot(document.getElementById('root')!).render(<CardPrintApp />);
