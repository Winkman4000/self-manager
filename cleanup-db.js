const { MongoClient } = require('mongodb');

async function cleanup() {
    const client = new MongoClient('mongodb://localhost:27017');
    
    try {
        await client.connect();
        console.log('Connected to MongoDB');
        
        const db = client.db('hope-app');
        const media = db.collection('media');
        
        // Remove localPath field from all entries
        const result = await media.updateMany(
            { localPath: { $exists: true } },
            { $unset: { localPath: "" } }
        );
        
        console.log(`Removed localPath from ${result.modifiedCount} entries`);
        
        // Show final status
        const entriesWithLocalPath = await media.countDocuments({ localPath: { $exists: true } });
        console.log(`Entries with localPath remaining: ${entriesWithLocalPath}`);
        
    } catch (error) {
        console.error('Cleanup failed:', error);
    } finally {
        await client.close();
    }
}

cleanup(); 
