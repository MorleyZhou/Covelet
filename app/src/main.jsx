import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { initializeLanguage, tr } from "./i18n/index.js";
import { initializeLocalData } from './lib/initialize-local-data.js';
import { Button } from './components/ui/button.jsx';
import { Disclosure } from './components/ui/disclosure.jsx';
import { userErrorMessage } from './lib/user-error.js';
import "./styles.css";

const root = createRoot(document.getElementById('root'));
async function start() {
  root.render(<main className="local-data-startup" role="status">{tr('正在准备本机数据…')}</main>);
  try {
    await initializeLanguage(); await initializeLocalData();
    root.render(<React.StrictMode><App /></React.StrictMode>);
  } catch (error) {
    root.render(<main className="local-data-startup"><p role="alert">{userErrorMessage(error, tr('无法打开本机数据，原数据已保留。'))}</p>
      <Disclosure title={tr('技术详情')}><p>{error.message}</p></Disclosure><Button onClick={start}>{tr('重试')}</Button></main>);
  }
}
start();
