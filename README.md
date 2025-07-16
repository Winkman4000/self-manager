# Self Manager

Self Manager is a desktop application built with Electron. It stores media links in MongoDB and integrates with a Telegram bot for easy submission of URLs.

## Prerequisites

- **Node.js** (version 18 or higher recommended)
- **MongoDB** running locally on `mongodb://localhost:27017`
- **Electron** (installed automatically with `npm install`)

## Setup

1. Install the project dependencies:

```bash
npm install
```

2. Create a `.env` file in the project root and set your Telegram credentials:

```env
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
```

3. Ensure your MongoDB service is running.

4. Start the application:

```bash
npm start
```

The Electron window should open and connect to your local MongoDB instance.

### Optional Maintenance

Run `cleanup-db.js` to remove the `localPath` field from all database entries:

```bash
node cleanup-db.js
```

This can help tidy up records if you change how files are stored.

