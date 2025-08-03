const fs = require('fs');
const path = require('path');
const ConnectionManager = require('../server/db/ConnectionManager');

async function migrate() {
    console.log('🚀 Starting database migration...');

    try {
        await ConnectionManager.initializeDatabasePool();
        const schemaPath = path.join(__dirname, '../server/db/schema.sql');
        const schemaSQL = fs.readFileSync(schemaPath, 'utf8');

        console.log('Executing schema.sql...');
        await ConnectionManager.executeQuery(schemaSQL);
        console.log('✅ Database migration completed successfully.');

    } catch (error) {
        console.error('❌ Database migration failed:', error.message);
    } finally {
        await ConnectionManager.close();
    }
}

migrate();
