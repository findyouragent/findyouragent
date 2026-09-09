import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { I18nProvider } from './i18n/index.jsx';
import './styles/tokens.css';
import './styles/index.css';
import './styles/flow-button.css';
import './styles/weave-spinner.css';
import './styles/trace.css';
import './styles/i18n.css';

function StartupComplete() {
  React.useLayoutEffect(() => {
    window.dispatchEvent(new Event('fya:ready'));
  }, []);
  return null;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider><App /></I18nProvider>
    <StartupComplete />
  </React.StrictMode>
);
