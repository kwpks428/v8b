const dotenv = require('dotenv');
dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

const ConnectionManager = require('../server/db/ConnectionManager');

async function migrateClaimTable() {
    console.log('🚀 Starting claim table migration...');

    try {
        await ConnectionManager.initializeDatabasePool();

        // 1. Drop the old unique constraint on tx_hash (if it exists)
        console.log('Attempting to drop old unique constraint on tx_hash...');
        try {
            await ConnectionManager.executeQuery('ALTER TABLE claim DROP CONSTRAINT claim_tx_hash_key;');
            console.log('✅ Old unique constraint (claim_tx_hash_key) dropped.');
        } catch (error) {
            if (error.code === '42P01' || error.code === '42704') { // 42P01: undefined_table, 42704: undefined_object
                console.log('⚠️ Old unique constraint does not exist or already dropped.');
            } else {
                console.warn('⚠️ Error dropping old constraint (may not exist):', error.message);
            }
        }

        // 2. Add the new composite unique constraint
        console.log('Attempting to add new composite unique constraint...');
        const addConstraintQuery = 'ALTER TABLE claim ADD CONSTRAINT unique_claim_tx_bet_wallet UNIQUE (tx_hash, bet_epoch, wallet_address);';
        await ConnectionManager.executeQuery(addConstraintQuery);
        console.log('✅ New composite unique constraint (unique_claim_tx_bet_wallet) added successfully.');

        console.log('✅ Claim table migration completed successfully.');

    } catch (error) {
        console.error('❌ Claim table migration failed:', error.message);
    } finally {
        await ConnectionManager.close();
    }
}

migrateClaimTable();
