const dotenv = require('dotenv');
dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

const ConnectionManager = require('../server/db/ConnectionManager');

async function fixConstraint() {
    console.log('🚀 Applying database constraint fix...');

    const alterQuery = 'ALTER TABLE multi_round_claimer ADD CONSTRAINT unique_claim_wallet UNIQUE (claim_epoch, wallet_address);';

    try {
        await ConnectionManager.initializeDatabasePool();
        console.log('Executing ALTER TABLE command...');
        await ConnectionManager.executeQuery(alterQuery);
        console.log('✅ Constraint added successfully.');
    } catch (error) {
        if (error.code === '42P07') { // 42P07 is the error code for "duplicate_table" or "relation_already_exists"
            console.log('⚠️ Constraint already exists, no action needed.');
        } else {
            console.error('❌ Failed to apply constraint fix:', error.message);
        }
    } finally {
        await ConnectionManager.close();
    }
}

fixConstraint();
