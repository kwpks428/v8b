const dotenv = require('dotenv');
dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

const ConnectionManager = require('../server/db/ConnectionManager');

async function verifyMultiClaim() {
    console.log('🚀 Starting multi-claim data verification...');

    const verificationTargets = [
        {
            wallet: '0x2a2d9330f57b07a0bc4e4dd843d99cc92503bdbf',
            claimEpoch: 401083,
            expectedRoundsClaimed: 12
        },
        {
            wallet: '0xf5fe264ca2a7f0993cbf98949f85e35b706ec206',
            claimEpoch: 401066,
            expectedRoundsClaimed: 39
        }
    ];

    try {
        await ConnectionManager.initializeDatabasePool();

        for (const target of verificationTargets) {
            const { wallet, claimEpoch, expectedRoundsClaimed } = target;
            console.log(`\n--- Verifying Wallet: ${wallet}, Claim Epoch: ${claimEpoch} ---`);

            // 1. Query multi_round_claimer table
            console.log(`🔍 Querying multi_round_claimer for wallet ${wallet} in epoch ${claimEpoch}...`);
            const multiClaimResult = await ConnectionManager.executeQuery(
                'SELECT rounds_claimed FROM multi_round_claimer WHERE wallet_address = $1 AND claim_epoch = $2',
                [wallet.toLowerCase(), claimEpoch]
            );

            if (multiClaimResult.rows.length === 0) {
                console.log(`❌ No record found in multi_round_claimer for ${wallet} in epoch ${claimEpoch}.`);
                continue; // Move to next target
            }

            const recordedRoundsClaimed = multiClaimResult.rows[0].rounds_claimed;
            console.log(`📊 Recorded rounds_claimed in multi_round_claimer: ${recordedRoundsClaimed}`);

            // 2. Query claim table for actual distinct bet_epochs
            console.log(`🔍 Querying claim table for distinct bet_epochs for wallet ${wallet} in epoch ${claimEpoch}...`);
            const actualBetEpochsResult = await ConnectionManager.executeQuery(
                'SELECT COUNT(DISTINCT bet_epoch) AS actual_distinct_bet_epochs FROM claim WHERE wallet_address = $1 AND epoch = $2',
                [wallet.toLowerCase(), claimEpoch]
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
        }

    } catch (error) {
        console.error('❌ Verification failed:', error.message);
    } finally {
        await ConnectionManager.close();
    }
}

verifyMultiClaim();