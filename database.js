const { MongoClient } = require('mongodb');

const uri = 'mongodb://localhost:27017';
const client = new MongoClient(uri);

let db;

async function connectToDb() {
    if (db) return db;
    try {
        await client.connect();
        console.log('Connected to MongoDB');
        db = client.db('hope-app');
        // Create indexes for searching
        await db.collection('media').createIndex({ title: 'text', hashtags: 'text' });
        await db.collection('playlists').createIndex({ name: 1 });
        return db;
    } catch (err) {
        console.error('Failed to connect to MongoDB', err);
        process.exit(1);
    }
}

function getDb() {
    if (!db) {
        throw new Error('Database not initialized. Call connectToDb first.');
    }
    return db;
}

module.exports = { connectToDb, getDb }; 
