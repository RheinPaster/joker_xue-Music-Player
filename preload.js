"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("JX", {
  loadState: () => ipcRenderer.invoke("jx:load-state"),
  saveState: (data) => ipcRenderer.invoke("jx:save-state", data),
  selectFolder: () => ipcRenderer.invoke("jx:select-folder"),
  chooseCover: (payload) => ipcRenderer.invoke("jx:choose-cover", payload),
  fetchCover: (query) => ipcRenderer.invoke("jx:fetch-cover", query),
  fetchLyrics: (query) => ipcRenderer.invoke("jx:fetch-lyrics", query),
  saveLrc: (payload) => ipcRenderer.invoke("jx:save-lrc", payload),
  version: () => ipcRenderer.invoke("jx:version")
});
