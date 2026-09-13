const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  show: file => ipcRenderer.send('tabs:show', file),
  reload: () => ipcRenderer.send('tabs:reload'),
  onState: fn => ipcRenderer.on('tabs:state', (_e, state) => fn(state)),
});
