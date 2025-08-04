const dotenv = require('dotenv');
dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

const ConnectionManager = require('../server/db/ConnectionManager');

async function verifyMultiClaim() {
    console.log('🚀 Starting multi-claim data verification...');

    const targetWallet = '0xaa18ac9e18e1517a11e2e9444a7f353a5d4e28b9';
    const targetClaimEpoch = 401002;
    const expectedRoundsClaimed = 15;

    try {
        await ConnectionManager.initializeDatabasePool();

        // 1. Query multi_round_claimer table
        console.log(`🔍 Querying multi_round_claimer for wallet ${targetWallet} in epoch ${targetClaimEpoch}...`);
        const multiClaimResult = await ConnectionManager.executeQuery(
            'SELECT rounds_claimed FROM multi_round_claimer WHERE wallet_address = $1 AND claim_epoch = $2',
            [targetWallet.toLowerCase(), targetClaimEpoch]
        );

        if (multiClaimResult.rows.length === 0) {
            console.log(`❌ No record found in multi_round_claimer for ${targetWallet} in epoch ${targetClaimEpoch}.`);
            return;
        }

        const recordedRoundsClaimed = multiClaimResult.rows[0].rounds_claimed;
        console.log(`📊 Recorded rounds_claimed in multi_round_claimer: ${recordedRoundsClaimed}`);

        // 2. Query claim table for actual distinct bet_epochs
        console.log(`🔍 Querying claim table for distinct bet_epochs for wallet ${targetWallet} in epoch ${targetClaimEpoch}...`);
        const actualBetEpochsResult = await ConnectionManager.executeQuery(
            'SELECT COUNT(DISTINCT bet_epoch) AS actual_distinct_bet_epochs FROM claim WHERE wallet_address = $1 AND epoch = $2',
            [targetWallet.toLowerCase(), targetClaimEpoch]
        );

        const actualDistinctBetEpochs = actualBetEpochsResult.rows[0].actual_distinct_bet_epochs;
        console.log(`📊 Actual distinct bet_epochs in claim table: ${actualDistinctBetEpochs}`);

        // 3. Compare and verify
        console.log('--- Verification Result ---');
        if (recordedRoundsClaimed === actualDistinctBetEpochs) {
            console.log(`✅ VERIFICATION SUCCESS: Recorded rounds_claimed (${recordedRoundsClaimed}) matches actual distinct bet_epochs (${actualDistinctBetEpochs}).`);
        } else {
            console.log(`❌ VERIFICATION FAILED: Recorded rounds_claimed (${recordedRoundsClaimed}) DOES NOT match actual distinct bet_epochs (${actualDistinctBetEpochs}).`);
        }
        console.log(`Expected rounds_claimed: ${expectedRoundsClaimed}`);
        if (recordedRoundsClaimed === expectedRoundsClaimed) {
            console.log(`✅ Recorded rounds_claimed matches expected value (${expectedRoundsClaimed}).`);
        } else {
            console.log(`❌ Recorded rounds_claimed DOES NOT match expected value (${expectedRoundsClaimed}).`);
        }

    } catch (error) {
        console.error('❌ Verification failed:', error.message);
    } finally {
        await ConnectionManager.close();
    }
}

verifyMultiClaim();
