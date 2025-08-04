const { ethers } = require('ethers');
const ConnectionManager = require('../db/ConnectionManager');
const TimeService = require('../services/TimeService');

class V6SingleRoundClaimDetector {
    constructor(db) {
        this.db = db;
        this.suspiciousThreshold = 3;
    }

    async checkSingleRoundMultiClaims(epoch, claimData) {
        try {
            const walletStats = {};
            for (const claim of claimData) {
                const wallet = claim.wallet_address.toLowerCase();
                const amount = parseFloat(claim.claim_amount);
                const betEpoch = claim.bet_epoch;
                if (!walletStats[wallet]) {
                    walletStats[wallet] = { betEpochs: new Set(), totalAmount: 0, claimCount: 0 };
                }
                walletStats[wallet].betEpochs.add(betEpoch);
                walletStats[wallet].totalAmount += amount;
                walletStats[wallet].claimCount++;
            }

            const suspiciousWallets = [];
            for (const [wallet, stats] of Object.entries(walletStats)) {
                const uniqueBetEpochs = stats.betEpochs.size;
                if (uniqueBetEpochs > this.suspiciousThreshold) {
                    suspiciousWallets.push({
                        wallet_address: wallet,
                        epoch: epoch,
                        claim_count: uniqueBetEpochs, // 改為不同bet_epoch的數量
                        total_amount: stats.totalAmount,
                        betEpochs: Array.from(stats.betEpochs) // 傳遞實際的bet_epochs陣列
                    });
                    console.log(`🚨 Suspicious multi-claim detected: ${wallet} claimed ${uniqueBetEpochs} different bet epochs in epoch ${epoch}`);
                }
            }

            if (suspiciousWallets.length > 0) {
                await this.recordSuspiciousWallets(suspiciousWallets);
            }
            return suspiciousWallets;
        } catch (error) {
            console.error('❌ Single round multi-claim check failed:', error);
            return [];
        }
    }

    async recordSuspiciousWallets(suspiciousWallets) {
        try {
            for (const suspicious of suspiciousWallets) {
                const query = `
                    INSERT INTO multi_round_claimer (claim_epoch, wallet_address, rounds_claimed, total_amount, bet_epochs)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (claim_epoch, wallet_address) DO UPDATE SET
                        rounds_claimed = EXCLUDED.rounds_claimed,
                        total_amount = EXCLUDED.total_amount,
                        bet_epochs = EXCLUDED.bet_epochs;
                `;
                const betEpochs = Array.from(suspicious.betEpochs || []);
                await this.db.executeQuery(query, [suspicious.epoch, suspicious.wallet_address, suspicious.claim_count, suspicious.total_amount, betEpochs]);
            }
            console.log(`✅ Recorded ${suspiciousWallets.length} suspicious wallets to multi_round_claimer table`);
        } catch (error) {
            console.error('❌ Failed to record suspicious wallets:', error);
        }
    }
}

class HistoricalCrawler {
    constructor() {
        this.connectionManager = ConnectionManager;
        this.contract = null;
        this.provider = null;
        this.treasuryFeeRate = 0.03;
        this.maxRequestsPerSecond = 100;
        this.requestDelay = Math.ceil(1000 / this.maxRequestsPerSecond);
        this.lastRequestTime = 0;
        this.claimDetector = null;
        this.failedAttempts = new Map();
        this.isProcessingHistory = false;
        this.shouldStopHistory = false;
        this.stats = { roundsProcessed: 0, betsProcessed: 0, claimsProcessed: 0, suspiciousWalletsDetected: 0, errors: 0 };
    }

    async initialize() {
        try {
            console.log('🔄 Initializing Historical Crawler...');
            await this.connectionManager.initialize();
            this.provider = this.connectionManager.getHttpProvider();
            this.contract = this.connectionManager.getContract();
            this.claimDetector = new V6SingleRoundClaimDetector(this.connectionManager);
            console.log('🚀 Historical Crawler initialized successfully');
        } catch (error) {
            console.error('❌ Historical Crawler initialization failed:', error);
            throw error;
        }
    }

    async rateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.requestDelay) {
            await new Promise(resolve => setTimeout(resolve, this.requestDelay - timeSinceLastRequest));
        }
        this.lastRequestTime = Date.now();
    }

    async retryRequest(operation, operationName, retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await this.rateLimit();
                return await operation();
            } catch (error) {
                if (attempt === retries) {
                    console.error(`❌ ${operationName} failed after ${retries} attempts:`, error.message);
                    throw error;
                }
                const delay = 2000 * attempt;
                console.log(`⚠️ Retrying ${operationName} (attempt ${attempt}/${retries}) after ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    async getCurrentEpoch() {
        return Number(await this.retryRequest(() => this.contract.currentEpoch(), 'getCurrentEpoch'));
    }

    calculatePayouts(totalAmount, upAmount, downAmount) {
        const totalAfterFee = totalAmount * (1 - this.treasuryFeeRate);
        const upPayout = upAmount > 0 ? (totalAfterFee / upAmount).toFixed(4) : 0;
        const downPayout = downAmount > 0 ? (totalAfterFee / downAmount).toFixed(4) : 0;
        return { upPayout, downPayout };
    }

    async hasRoundData(epoch) {
        const result = await this.connectionManager.executeQuery('SELECT epoch FROM round WHERE epoch = $1', [epoch]);
        return result.rows.length > 0;
    }

    async getRoundData(epoch) {
        const round = await this.retryRequest(() => this.contract.rounds(epoch), `getRoundData for epoch ${epoch}`);
        if (Number(round.closeTimestamp) === 0) return null;

        const result = Number(round.closePrice) > Number(round.lockPrice) ? 'UP' : 'DOWN';
        const totalAmount = parseFloat(ethers.formatEther(round.totalAmount));
        const bullAmount = parseFloat(ethers.formatEther(round.bullAmount));
        const bearAmount = parseFloat(ethers.formatEther(round.bearAmount));
        const payouts = this.calculatePayouts(totalAmount, bullAmount, bearAmount);

        return {
            epoch: Number(round.epoch),
            start_ts: TimeService.formatUnixTimestamp(Number(round.startTimestamp)),
            lock_ts: TimeService.formatUnixTimestamp(Number(round.lockTimestamp)),
            close_ts: TimeService.formatUnixTimestamp(Number(round.closeTimestamp)),
            raw_start_timestamp: Number(round.startTimestamp),
            lock_price: ethers.formatUnits(round.lockPrice, 8),
            close_price: ethers.formatUnits(round.closePrice, 8),
            result,
            total_amount: totalAmount.toString(),
            up_amount: bullAmount.toString(),
            down_amount: bearAmount.toString(),
            up_payout: payouts.upPayout,
            down_payout: payouts.downPayout
        };
    }

    async findBlockByTimestamp(targetTimestamp) {
        const currentBlock = await this.retryRequest(() => this.provider.getBlockNumber(), 'getBlockNumber');
        let low = 1;
        let high = currentBlock;
        let closestBlock = high;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const block = await this.retryRequest(() => this.provider.getBlock(mid), `getBlock ${mid}`);
            if (!block) {
                high = mid - 1;
                continue;
            }
            if (block.timestamp < targetTimestamp) {
                low = mid + 1;
            } else if (block.timestamp > targetTimestamp) {
                high = mid - 1;
            } else {
                return mid;
            }
            closestBlock = mid;
        }
        return closestBlock;
    }

    async getEventsInRange(fromBlock, toBlock) {
        const betBullFilter = this.contract.filters.BetBull();
        const betBearFilter = this.contract.filters.BetBear();
        const claimFilter = this.contract.filters.Claim();

        const [betBullEvents, betBearEvents, claimEvents] = await Promise.all([
            this.retryRequest(() => this.contract.queryFilter(betBullFilter, fromBlock, toBlock), 'getBetBullEvents'),
            this.retryRequest(() => this.contract.queryFilter(betBearFilter, fromBlock, toBlock), 'getBetBearEvents'),
            this.retryRequest(() => this.contract.queryFilter(claimFilter, fromBlock, toBlock), 'getClaimEvents')
        ]);

        return { betBullEvents, betBearEvents, claimEvents };
    }

    async processEpochData(epoch) {
        try {
            console.log(`🔄 Processing epoch ${epoch}...`);
            if (await this.shouldSkipEpoch(epoch)) {
                console.log(`⏭️ Skipping epoch ${epoch} due to too many failures.`);
                return false;
            }

            const roundData = await this.getRoundData(epoch);
            if (!roundData) {
                console.log(`⏭️ Epoch ${epoch} is not finished or data is invalid.`);
                return false;
            }

            const nextEpochStartTime = await this.getNextEpochStartTime(epoch + 1);
            if (!nextEpochStartTime) {
                console.log(`⏭️ Cannot get start time for epoch ${epoch + 1}, skipping.`);
                return false;
            }

            const fromBlock = await this.findBlockByTimestamp(roundData.raw_start_timestamp);
            const toBlock = await this.findBlockByTimestamp(nextEpochStartTime);
            if (!fromBlock || !toBlock) throw new Error('Could not determine block range.');

            const events = await this.getEventsInRange(fromBlock, toBlock);
            const betData = [];
            await this.processBetEvents(events.betBullEvents, 'UP', betData, roundData.result);
            await this.processBetEvents(events.betBearEvents, 'DOWN', betData, roundData.result);

            const claimData = [];
            await this.processClaimEvents(events.claimEvents, claimData, epoch);

            const success = await this.saveCompleteRoundData(roundData, betData, claimData);
            if (success) {
                await this.cleanupRealbetData(epoch);
                const suspiciousWallets = await this.claimDetector.checkSingleRoundMultiClaims(epoch, claimData);
                if (suspiciousWallets.length > 0) {
                    this.stats.suspiciousWalletsDetected += suspiciousWallets.length;
                }
                this.failedAttempts.delete(epoch);
                this.stats.roundsProcessed++;
                this.stats.betsProcessed += betData.length;
                this.stats.claimsProcessed += claimData.length;
                console.log(`✅ Epoch ${epoch} processed successfully.`);
                return true;
            }
            await this.handleEpochFailure(epoch, 'Failed to save data');
            return false;
        } catch (error) {
            console.error(`❌ Error processing epoch ${epoch}:`, error.message);
            await this.handleEpochFailure(epoch, error.message);
            this.stats.errors++;
            return false;
        }
    }

    async getNextEpochStartTime(nextEpoch) {
        const round = await this.retryRequest(() => this.contract.rounds(nextEpoch), `getNextEpochStartTime for ${nextEpoch}`);
        return Number(round.startTimestamp) === 0 ? null : Number(round.startTimestamp);
    }

    async processBetEvents(events, direction, betData, roundResult) {
        for (const event of events) {
            const blockTimestamp = (await this.retryRequest(() => this.provider.getBlock(event.blockNumber), `getBlock ${event.blockNumber}`)).timestamp;
            betData.push({
                epoch: Number(event.args.epoch),
                bet_ts: TimeService.formatUnixTimestamp(blockTimestamp),
                wallet_address: event.args.sender.toLowerCase(),
                bet_direction: direction,
                amount: ethers.formatEther(event.args.amount),
                result: roundResult ? (direction === roundResult ? 'WIN' : 'LOSS') : null,
                tx_hash: event.transactionHash
            });
        }
    }

    async processClaimEvents(events, claimData, processingEpoch) {
        for (const event of events) {
            const blockTimestamp = (await this.retryRequest(() => this.provider.getBlock(event.blockNumber), `getBlock ${event.blockNumber}`)).timestamp;
            claimData.push({
                epoch: processingEpoch,
                claim_ts: TimeService.formatUnixTimestamp(blockTimestamp),
                wallet_address: event.args.sender.toLowerCase(),
                claim_amount: ethers.formatEther(event.args.amount),
                bet_epoch: Number(event.args.epoch),
                tx_hash: event.transactionHash
            });
        }
    }

    async saveCompleteRoundData(roundData, betData, claimData) {
        const queries = [];
        queries.push({
            sql: `INSERT INTO round (epoch, start_ts, lock_ts, close_ts, lock_price, close_price, result, total_amount, up_amount, down_amount, up_payout, down_payout) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (epoch) DO NOTHING`,
            params: [roundData.epoch, roundData.start_ts, roundData.lock_ts, roundData.close_ts, roundData.lock_price, roundData.close_price, roundData.result, roundData.total_amount, roundData.up_amount, roundData.down_amount, roundData.up_payout, roundData.down_payout]
        });

        betData.forEach(bet => {
            queries.push({
                sql: `INSERT INTO hisbet (epoch, bet_ts, wallet_address, bet_direction, amount, result, tx_hash) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tx_hash) DO NOTHING`,
                params: [bet.epoch, bet.bet_ts, bet.wallet_address, bet.bet_direction, bet.amount, bet.result, bet.tx_hash]
            });
        });

        claimData.forEach(claim => {
            queries.push({
                sql: `INSERT INTO claim (epoch, claim_ts, wallet_address, claim_amount, bet_epoch, tx_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tx_hash) DO NOTHING`,
                params: [claim.epoch, claim.claim_ts, claim.wallet_address, claim.claim_amount, claim.bet_epoch, claim.tx_hash]
            });
        });

        try {
            await this.connectionManager.executeTransaction(queries);
            console.log(`✅ Transaction for epoch ${roundData.epoch} committed successfully.`);
            return true;
        } catch (error) {
            console.error(`❌ Transaction for epoch ${roundData.epoch} failed:`, error.message);
            return false;
        }
    }

    async cleanupRealbetData(epoch) {
        await this.connectionManager.executeQuery('DELETE FROM realbet WHERE epoch = $1', [epoch]);
        console.log(`🧹 Cleaned up realbet data for epoch ${epoch}.`);
    }

    async handleEpochFailure(epoch, reason) {
        const attempts = (this.failedAttempts.get(epoch) || 0) + 1;
        this.failedAttempts.set(epoch, attempts);
        if (attempts >= 3) {
            await this.recordFailedEpoch(epoch, reason);
            console.log(`🚫 Epoch ${epoch} failed 3 times, recording and skipping.`);
            this.failedAttempts.delete(epoch);
        } else {
            await this.connectionManager.executeQuery('DELETE FROM round WHERE epoch = $1', [epoch]);
            console.log(`🗑️ Deleted partial data for epoch ${epoch}, will retry (attempt ${attempts}/3).`);
        }
    }

    async recordFailedEpoch(epoch, errorMessage) {
        await this.connectionManager.executeQuery('INSERT INTO failed_epoch (epoch, error_message, last_attempt_ts) VALUES ($1, $2, NOW()) ON CONFLICT (epoch) DO UPDATE SET error_message = EXCLUDED.error_message, last_attempt_ts = NOW(), failure_count = failed_epoch.failure_count + 1', [epoch, errorMessage]);
    }

    async shouldSkipEpoch(epoch) {
        const result = await this.connectionManager.executeQuery('SELECT failure_count FROM failed_epoch WHERE epoch = $1', [epoch]);
        return result.rows.length > 0 && result.rows[0].failure_count >= 3;
    }

    async processHistoryData() {
        if (this.isProcessingHistory) return;
        this.isProcessingHistory = true;
        this.shouldStopHistory = false;

        let checkEpoch = (await this.getCurrentEpoch()) - 2;
        console.log(`📚 Starting history backfill from epoch ${checkEpoch}...`);

        while (this.isProcessingHistory && !this.shouldStopHistory && checkEpoch > 0) {
            if (!(await this.hasRoundData(checkEpoch))) {
                await this.processEpochData(checkEpoch);
            }
            checkEpoch--;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        this.isProcessingHistory = false;
    }

    start() {
        console.log('🚀 Starting Historical Crawler periodic tasks...');
        this.processHistoryData(); // Start immediately
        setInterval(() => this.processHistoryData(), 30 * 60 * 1000); // Run every 30 minutes
    }
}

module.exports = HistoricalCrawler;
