const { contextBridge, ipcRenderer, desktopCapturer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer,
  desktopCapturer,
  getStreamBase: () => ipcRenderer.invoke('get-stream-base'),
  listRecordings: () => ipcRenderer.invoke('list-recordings'),
  downloadAudio: (url) => ipcRenderer.send('download-audio', url),
  downloadVideo: (url) => ipcRenderer.send('download-video', url),
  getStreamURL: (url) => ipcRenderer.invoke('get-stream-url', url),
  fetchTitle: (url) => ipcRenderer.invoke('fetch-title', url),
  getLinks: () => ipcRenderer.invoke('get-links'),
  storeLink: (linkObj) => ipcRenderer.send('store-link', linkObj),
  renameLink: (link) => ipcRenderer.send('rename-link', link),
  deleteLink: (url) => ipcRenderer.send('delete-link', url),
  deleteLocalFile: (filename) => ipcRenderer.send('delete-local-file', filename),
  addHashtag: (data) => ipcRenderer.send('add-hashtag', data),
  searchMedia: (query) => ipcRenderer.invoke('search-media', query),
  getPlaylists: () => ipcRenderer.invoke('get-playlists'),
  createPlaylist: (name) => ipcRenderer.send('create-playlist', name),
  addToPlaylist: (plId, itemId) => ipcRenderer.send('add-to-playlist', { plId, itemId }),
  removeFromPlaylist: (plId, itemId) => ipcRenderer.send('remove-from-playlist', { plId, itemId }),
  reorderPlaylist: (plId, order) => ipcRenderer.send('reorder-playlist', { plId, order }),
  shufflePlaylist: (plId) => ipcRenderer.invoke('shuffle-playlist', plId)
});
