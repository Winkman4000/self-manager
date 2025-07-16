const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra'); // Still needed for file system ops
const express = require('express');
const os = require('os');
const youtubedl = require('youtube-dl-exec');
const { connectToDb, getDb } = require('./database');
const { ObjectId } = require('mongodb');
require('dotenv').config();

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadFile('index.html');
}

// ---- Remove JSON file link storage ----
// const linksFile = path.join(__dirname, 'links.json');
// let links = [];
// async function loadLinks() {
//   try {
//     links = await fs.readJson(linksFile);
//   } catch {
//     links = [];
//   }
// }
// function saveLinks() {
//   fs.writeJson(linksFile, links).catch(()=>{});
// }

async function migrateExistingRecordings() {
    const media = getDb().collection('media');
    const recordingsDir = path.join(__dirname, 'recordings');
    try {
        await fs.ensureDir(recordingsDir);
        const files = await fs.readdir(recordingsDir);

        logMessage(`Starting migration of ${files.length} files to MongoDB...`);

        for (const file of files) {
            const filePath = path.join(recordingsDir, file);
            const stats = await fs.stat(filePath);
            
            if (stats.isFile()) {
                const localPath = `recordings/${file}`;
                const fileExtension = path.extname(file);
                const filename = path.parse(file).name;
                
                // Check if this file is already migrated to MongoDB
                const existing = await media.findOne({ 
                    $or: [
                        { localPath: localPath },
                        { localPath: `recordings\\${file}` }
                    ]
                });
                
                if (existing && !existing.audioData) {
                    // Migrate existing entry to MongoDB storage
                    logMessage(`Migrating ${file} to MongoDB...`);
                    const audioData = await fs.readFile(filePath);
                    
                    await media.updateOne(
                        { _id: existing._id },
                        { 
                            $set: {
                                audioData: audioData,
                                fileExtension: fileExtension,
                                fileSize: audioData.length
                            },
                            $unset: { localPath: "" }
                        }
                    );
                    
                    // Delete the local file
                    await fs.remove(filePath);
                    logMessage(`Migrated and deleted local file: ${file}`);
                } else if (!existing) {
                    // Create new entry for orphaned file and migrate it
                    logMessage(`Creating new entry and migrating ${file} to MongoDB...`);
                    const audioData = await fs.readFile(filePath);
                    
                    await media.insertOne({
                        title: filename.replace(/_/g, ' '),
                        url: `https://youtube.com/watch?v=${filename}`,
                        audioData: audioData,
                        fileExtension: fileExtension,
                        fileSize: audioData.length,
                        isDownloaded: true,
                        hashtags: [],
                        createdAt: new Date()
                    });
                    
                    // Delete the local file
                    await fs.remove(filePath);
                    logMessage(`Created new entry and migrated: ${file}`);
                }
            }
        }
        
        logMessage('Migration completed successfully!');
    } catch (err) {
        logMessage(`Migration error: ${err.message}`);
    }
}

async function sendMediaUpdate(window) {
    if (!window) return;
    const media = getDb().collection('media');
    const allMedia = await media.find({}).sort({ createdAt: -1 }).toArray();

    // Calculate total size of downloaded files from MongoDB
    let totalSizeBytes = 0;
    for (const item of allMedia) {
        if (item.isDownloaded && item.fileSize) {
            totalSizeBytes += item.fileSize;
        }
    }

    // Convert ObjectIds to strings for serialization
    const serializableMedia = allMedia.map(item => ({ ...item, _id: item._id.toString() }));
    window.webContents.send('links-updated', {
        media: serializableMedia,
        totalSize: totalSizeBytes
    });
}

app.whenReady().then(async () => {
  await connectToDb(); // Connect to the database on startup
      // await migrateExistingRecordings(); // Migration already completed
  createWindow();

  mainWindow.webContents.on('did-finish-load', () => {
      sendMediaUpdate(mainWindow);
  });

  function logMessage(msg) {
    console.log(msg);
    if(mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('debug-log', msg);
    }
  }

  logMessage('App ready');

  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
    bot.on('message', async (msg) => {
        logMessage(`Received Telegram message: ${msg.text} from chat ${msg.chat.id}`);
        if (msg.chat.id.toString() === process.env.TELEGRAM_CHAT_ID) {
            const url = msg.text;
            if (url && url.startsWith('http')) {
                logMessage(`Valid URL received: ${url}`);
                try {
                    const title = await youtubedl(url, { getTitle: true });
                    const linkObj = { url, title };
                    
                    // Directly add to DB, don't use IPC
                    const media = getDb().collection('media');
                    const existing = await media.findOne({ url: linkObj.url });
                    if (!existing) {
                        const doc = {
                            ...linkObj,
                            isDownloaded: false,
                            localPath: null,
                            hashtags: [],
                            createdAt: new Date()
                        };
                        await media.insertOne(doc);
                        logMessage(`Link stored in DB: ${linkObj.title}`);
                        sendMediaUpdate(mainWindow); // Update UI
                    }
                } catch (err) {
                    logMessage(`Failed to process Telegram link: ${err}`);
                }
            } else {
                logMessage('Invalid URL or empty message');
            }
        } else {
            logMessage(`Message from unauthorized chat: ${msg.chat.id}`);
        }
    });
  bot.on('error', (err) => logMessage(`Telegram bot error: ${err}`));

  // Express server
  const serverApp = express();
  serverApp.use('/recordings', express.static(path.join(__dirname, 'recordings')));
  
  // Serve audio data from MongoDB
  serverApp.get('/audio/:id', async (req, res) => {
    try {
      const media = getDb().collection('media');
      const item = await media.findOne({ _id: new ObjectId(req.params.id) });
      
      if (!item || !item.audioData) {
        return res.status(404).send('Audio not found');
      }
      
      const mimeType = item.fileExtension === '.mp4' ? 'video/mp4' : 
                       item.fileExtension === '.webm' ? 'audio/webm' :
                       item.fileExtension === '.m4a' ? 'audio/mp4' : 'audio/mpeg';
      
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', item.fileSize);
      res.send(item.audioData.buffer);
    } catch (err) {
      logMessage(`Error serving audio: ${err.message}`);
      res.status(500).send('Error serving audio');
    }
  });
  serverApp.listen(3000, () => logMessage('Streaming server started on port 3000'));

  // Get local IP
  const interfaces = os.networkInterfaces();
  const localIP = Object.values(interfaces).flat().find(iface => iface.family === 'IPv4' && !iface.internal).address;
  ipcMain.handle('get-stream-base', () => `http://${localIP}:3000/`);

  // IPC to save audio
  ipcMain.on('save-audio', async (event, { buffer, title }) => {
    try {
      logMessage(`Received save-audio request - Title: ${title}`);
      logMessage(`Buffer size: ${buffer.byteLength} bytes`);

      const recordingsDir = path.join(__dirname, 'recordings');
      logMessage(`Ensuring recordings directory exists: ${recordingsDir}`);
      await fs.ensureDir(recordingsDir);

      const filename = `${title.replace(/[^a-zA-Z0-9]/g, '_') || Date.now()}.webm`;
      const filepath = path.join(recordingsDir, filename);
      logMessage(`Saving to: ${filepath}`);

      await fs.writeFile(filepath, Buffer.from(buffer));
      logMessage(`File written successfully: ${filename}`);

      // Verify file was created
      const stats = await fs.stat(filepath);
      logMessage(`File stats - Size: ${stats.size} bytes, Created: ${stats.birthtime}`);

      event.reply('audio-saved', filename);
      logMessage(`Replied with audio-saved: ${filename}`);
    } catch (err) {
      logMessage(`Error saving audio: ${err.message}`);
      logMessage(`Error stack: ${err.stack}`);
    }
  });

  ipcMain.handle('list-recordings', async () => {
    try {
      logMessage('Listing recordings');
      const dir = path.join(__dirname, 'recordings');
      await fs.ensureDir(dir);
      return fs.readdir(dir);
    } catch (err) {
      logMessage(`Error listing recordings: ${err}`);
      return [];
    }
  });

  ipcMain.on('debug-log-renderer', (event, msg) => {
    console.log(`[Renderer] ${msg}`);
  });

  // Expose recorded links to renderer
  ipcMain.handle('get-links', async () => {
    const media = getDb().collection('media');
    const allMedia = await media.find({}).sort({ createdAt: -1 }).toArray();

    // Calculate total size of downloaded files from MongoDB
    let totalSizeBytes = 0;
    for (const item of allMedia) {
        if (item.isDownloaded && item.fileSize) {
            totalSizeBytes += item.fileSize;
        }
    }

    const serializableMedia = allMedia.map(item => ({ ...item, _id: item._id.toString() }));
    // Return the full payload
    return { media: serializableMedia, totalSize: totalSizeBytes };
  });

  ipcMain.on('store-link', async (event, linkObj) => {
      const media = getDb().collection('media');
      const existing = await media.findOne({ url: linkObj.url });
      if (!existing) {
          const doc = {
              ...linkObj,
              isDownloaded: false,
              localPath: null,
              hashtags: [],
              createdAt: new Date()
          };
          await media.insertOne(doc);
          logMessage(`Link stored in DB: ${linkObj.title}`);
          sendMediaUpdate(mainWindow);
      }
  });

  ipcMain.on('rename-link', async (event, { url, newTitle }) => {
    const media = getDb().collection('media');
    try {
      await media.updateOne({ url }, { $set: { title: newTitle } });
      logMessage(`Renamed link: ${newTitle}`);
      sendMediaUpdate(mainWindow);
    } catch (err) {
      logMessage(`Error renaming link: ${err}`);
    }
  });

  ipcMain.on('delete-media', async (event, id) => {
    if (!ObjectId.isValid(id)) {
        logMessage(`Invalid ID for deletion: ${id}`);
        return;
    }
    const media = getDb().collection('media');
    try {
        const item = await media.findOne({ _id: new ObjectId(id) });
        if (item && item.isDownloaded && item.localPath) {
            const localFilePath = path.join(__dirname, item.localPath);
            if (await fs.pathExists(localFilePath)) {
                await fs.unlink(localFilePath);
                logMessage(`Deleted local file: ${item.localPath}`);
            }
        }
        await media.deleteOne({ _id: new ObjectId(id) });
        logMessage(`Deleted media item from DB: ${id}`);
        sendMediaUpdate(mainWindow);
    } catch (err) {
        logMessage(`Error deleting media item ${id}: ${err}`);
    }
  });

  // Helper function to find the actual downloaded file
  async function findDownloadedFile(directory, baseName) {
    const files = await fs.readdir(directory);
    // Accept files whose base filename starts with the expected baseName (handles variant suffixes like .f140).
    const foundFile = files.find(f => path.parse(f).name.startsWith(baseName));
    return foundFile ? path.join('recordings', foundFile) : null;
  }

  // Download audio via youtube-dl-exec
  ipcMain.on('download-audio', async (event, itemId) => {
    logMessage(`Audio download request: ${itemId}`);
    try {
        // Get the URL from the database using the item ID
        const media = getDb().collection('media');
        const item = await media.findOne({ _id: new ObjectId(itemId) });
        if (!item) {
            logMessage(`No item found with ID: ${itemId}`);
            return;
        }
        
        const url = item.url;
        logMessage(`Found URL for download: ${url}`);
        
        const title = await youtubedl(url, { getTitle: true });
        const videoId = await youtubedl(url, { getId: true });
        const recordingsDir = path.join(__dirname, 'recordings');
        await fs.ensureDir(recordingsDir);
        const outputPath = path.join(recordingsDir, `${videoId}.%(ext)s`);

        youtubedl.exec(url, {
            output: outputPath,
            format: 'bestaudio/best'
        }).on('close', async () => {
            logMessage(`Audio download finished for ${url}`);
            const finalPath = await findDownloadedFile(recordingsDir, videoId);
            if(finalPath) {
                // Read the downloaded file and store it in MongoDB
                const fullPath = path.join(__dirname, finalPath);
                const audioData = await fs.readFile(fullPath);
                const fileExtension = path.extname(finalPath);
                
                // Update the existing entry with the audio data
                const result = await media.updateOne(
                    { _id: new ObjectId(itemId) }, 
                    { 
                        $set: {
                            isDownloaded: true,
                            audioData: audioData,
                            fileExtension: fileExtension,
                            fileSize: audioData.length
                        },
                        $addToSet: { hashtags: 'audioonly' },
                        $unset: { localPath: "" }
                    }
                );
                
                // Delete the local file since we have it in MongoDB now
                await fs.remove(fullPath);
                logMessage(`Stored audio data in MongoDB and deleted local file: ${finalPath}`);
                
                if (result.matchedCount === 0) {
                    logMessage('ERROR: Could not find item to update');
                } else {
                    logMessage('Updated existing entry with audio download');
                }
                sendMediaUpdate(mainWindow);
            } else {
                logMessage(`Could not find downloaded audio file for base name: ${videoId}`);
            }
        }).on('error', err => logMessage(`Audio download error: ${err.message}`));

    } catch (err) {
        logMessage(`Audio download error: ${err}`);
    }
  });

  ipcMain.on('download-video', async(event, itemId) => {
    logMessage(`Video download request: ${itemId}`);
    try {
        // Get the URL from the database using the item ID
        const media = getDb().collection('media');
        const item = await media.findOne({ _id: new ObjectId(itemId) });
        if (!item) {
            logMessage(`No item found with ID: ${itemId}`);
            return;
        }
        
        const url = item.url;
        logMessage(`Found URL for download: ${url}`);
        
        const title = await youtubedl(url, { getTitle: true });
        const videoId = await youtubedl(url, { getId: true });

        const recordingsDir = path.join(__dirname, 'recordings');
        await fs.ensureDir(recordingsDir);

        const finalFilename = `${videoId}.mp4`;
        const outputPath = path.join(recordingsDir, finalFilename);

        youtubedl.exec(url, {
            output: outputPath,
            format: 'best[ext=mp4]/best'
        }).on('close', async () => {
            logMessage(`Video download finished for ${url}`);
            const expectedPath = path.join('recordings', finalFilename);
            const fullPath = path.join(__dirname, expectedPath);
            if (await fs.pathExists(fullPath)) {
                // Read the downloaded file and store it in MongoDB
                const videoData = await fs.readFile(fullPath);
                const fileExtension = path.extname(finalFilename);
                
                // Update the existing entry with the video data
                const result = await media.updateOne(
                    { _id: new ObjectId(itemId) }, 
                    { 
                        $set: {
                            isDownloaded: true,
                            audioData: videoData,
                            fileExtension: fileExtension,
                            fileSize: videoData.length
                        },
                        $addToSet: { hashtags: 'fullmedia' },
                        $unset: { localPath: "" }
                    }
                );
                
                // Delete the local file since we have it in MongoDB now
                await fs.remove(fullPath);
                logMessage(`Stored video data in MongoDB and deleted local file: ${expectedPath}`);
                
                if (result.matchedCount === 0) {
                    logMessage('ERROR: Could not find item to update');
                } else {
                    logMessage('Updated existing entry with video download');
                }
                sendMediaUpdate(mainWindow);
            } else {
                logMessage(`Could not find downloaded video file: ${finalFilename}`);
            }
        }).on('error', err => logMessage(`Video download error: ${err.message}`));

    } catch(err) {
        logMessage(`Video download error: ${err.message}`);
    }
  });

  // Provide direct stream URL without downloading
  ipcMain.handle('get-stream-url', async (event, url) => {
    try {
      const streamUrl = await youtubedl(url, { getUrl: true, format: 'bestaudio' });
      return streamUrl;
    } catch (err) {
      logMessage(`get-stream-url error: ${err}`);
      return null;
    }
  });

  // Fetch title helper
  ipcMain.handle('fetch-title', async (event, url) => {
    try {
      const title = await youtubedl(url, { getTitle: true });
      return title;
    } catch (err) {
      logMessage(`fetch-title error: ${err}`);
      return url;
    }
  });

  ipcMain.on('delete-local-file', async (event, filename) => {
    try {
        const recordingsDir = path.join(__dirname, 'recordings');
        const filepath = path.join(recordingsDir, filename);
        if (await fs.pathExists(filepath)) {
            await fs.unlink(filepath);
            logMessage(`Deleted local file: ${filename}`);
            mainWindow.webContents.send('file-deleted', filename);
        } else {
            logMessage(`Attempted to delete non-existent file: ${filename}`);
        }
    } catch (err) {
        logMessage(`Error deleting local file ${filename}: ${err}`);
    }
  });

  // Add new handlers
  ipcMain.on('add-hashtag', async (event, { id, tag }) => {
      if (!ObjectId.isValid(id)) {
          logMessage(`Invalid ID received for add-hashtag: ${id}`);
          return;
      }
      const media = getDb().collection('media');
      await media.updateOne({ _id: new ObjectId(id) }, { $addToSet: { hashtags: tag } });
      logMessage(`Added tag ${tag} to media item ${id}`);
      sendMediaUpdate(mainWindow);
  });

  ipcMain.handle('search-media', async (event, query) => {
      const media = getDb().collection('media');
      let results;
      if (!query) {
          results = await media.find({}).sort({ createdAt: -1 }).toArray();
      } else {
          results = await media.find({ $text: { $search: query } }).toArray();
      }
      return results.map(item => ({ ...item, _id: item._id.toString() }));
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
}); 