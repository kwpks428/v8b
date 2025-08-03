const { ethers } = require('ethers');
const Database = require('./database');
const TimeUtils = require('./time-utils');

// 監控常量配置
const MONITORING_CONSTANTS = {
    MAX_BETS_PER_ROUND: 50, // 單局最大下注次數
    MAX_BET_AMOUNT: 10, // 單次最大下注金額 (BNB)
    SUSPICIOUS_BET_COUNT: 100, // 可疑下注總次數
    HIGH_FREQUENCY_WINDOW: 60 * 1000, // 高頻檢測窗口 (1分鐘)
    MAX_BETS_IN_WINDOW: 10, // 窗口內最大下注次數
    CLEANUP_INTERVAL: 60 * 60 * 1000, // 清理間隔 (1小時)
    CONNECTION_TIMEOUT: 10 * 1000, // 連接超時 (10秒)
    RECONNECT_DELAY: 10 * 1000 // 重連延遲 (10秒)
};

// 可疑錢包監控配置
class SuspiciousWalletMonitor {
    constructor() {
        this.suspiciousWallets = new Set();
        this.walletBetCounts = new Map(); // 錢包下注次數統計
        this.walletBetAmounts = new Map(); // 錢包下注金額統計
        this.roundBetCounts = new Map(); // 每局下注次數統計
        
        // 監控閾值配置
        this.thresholds = {
            maxBetsPerRound: MONITORING_CONSTANTS.MAX_BETS_PER_ROUND,
            maxBetAmount: MONITORING_CONSTANTS.MAX_BET_AMOUNT,
            suspiciousBetCount: MONITORING_CONSTANTS.SUSPICIOUS_BET_COUNT,
            highFrequencyWindow: MONITORING_CONSTANTS.HIGH_FREQUENCY_WINDOW,
            maxBetsInWindow: MONITORING_CONSTANTS.MAX_BETS_IN_WINDOW
        };
        
        this.recentBets = new Map(); // 存儲最近下注時間
    }
    
    // 檢查錢包是否可疑
    checkSuspiciousWallet(wallet, amount, epoch) {
        const amountBNB = parseFloat(amount);
        const now = Date.now();
        
        let flags = [];
        
        // 1. 檢查單次下注金額
        if (amountBNB > this.thresholds.maxBetAmount) {
            flags.push(`大額下注: ${amountBNB} BNB`);
        }
        
        // 2. 更新並檢查錢包總下注次數
        const currentCount = this.walletBetCounts.get(wallet) || 0;
        this.walletBetCounts.set(wallet, currentCount + 1);
        
        if (currentCount + 1 > this.thresholds.suspiciousBetCount) {
            flags.push(`高頻用戶: ${currentCount + 1} 次下注`);
        }
        
        // 3. 檢查高頻下注 (時間窗口內)
        if (!this.recentBets.has(wallet)) {
            this.recentBets.set(wallet, []);
        }
        
        const walletRecentBets = this.recentBets.get(wallet);
        // 清理過期記錄
        const validBets = walletRecentBets.filter(time => now - time < this.thresholds.highFrequencyWindow);
        validBets.push(now);
        this.recentBets.set(wallet, validBets);
        
        if (validBets.length > this.thresholds.maxBetsInWindow) {
            flags.push(`高頻下注: ${validBets.length} 次/分鐘`);
        }
        
        // 4. 檢查單局下注次數
        const roundKey = `${wallet}_${epoch}`;
        const roundCount = this.roundBetCounts.get(roundKey) || 0;
        this.roundBetCounts.set(roundKey, roundCount + 1);
        
        if (roundCount + 1 > 1) { // 正常情況下每局只能下注一次
            flags.push(`重複下注: 局次${epoch}第${roundCount + 1}次`);
        }
        
        // 5. 更新錢包總金額
        const currentAmount = this.walletBetAmounts.get(wallet) || 0;
        this.walletBetAmounts.set(wallet, currentAmount + amountBNB);
        
        // 如果有可疑標記，添加到可疑列表
        if (flags.length > 0) {
            this.suspiciousWallets.add(wallet);
            return {
                isSuspicious: true,
                flags: flags,
                totalBets: currentCount + 1,
                totalAmount: currentAmount + amountBNB
            };
        }
        
        return {
            isSuspicious: false,
            flags: [],
            totalBets: currentCount + 1,
            totalAmount: currentAmount + amountBNB
        };
    }
    
    // 獲取可疑錢包列表
    getSuspiciousWallets() {
        return Array.from(this.suspiciousWallets);
    }
    
    // 清理過期數據 (每小時執行一次)
    cleanup() {
        const now = Date.now();
        const oneHourAgo = now - 3600000;
        
        // 清理過期的最近下注記錄
        for (const [wallet, times] of this.recentBets.entries()) {
            const validTimes = times.filter(time => time > oneHourAgo);
            if (validTimes.length === 0) {
                this.recentBets.delete(wallet);
            } else {
                this.recentBets.set(wallet, validTimes);
            }
        }
        
        console.log('🧹 可疑錢包監控數據清理完成');
    }
}

class RealtimeListener {
    constructor() {
        this.db = new Database();
        this.suspiciousMonitor = new SuspiciousWalletMonitor();
        
        // 區塊鏈連接相關
        this.provider = null;
        this.contract = null;
        this.currentRound = null;
        this.currentLockTimestamp = null;
        this.isConnected = false;
        this.reconnectTimer = null;
        
        this.setupCleanupTimer();
    }

    setupCleanupTimer() {
        // 每小時清理一次過期數據
        setInterval(() => {
            this.suspiciousMonitor.cleanup();
        }, MONITORING_CONSTANTS.CLEANUP_INTERVAL);
    }

    async initialize() {
        try {
            console.log('🔄 初始化即時數據監聽器...');
            
            // 初始化數據庫
            await this.db.initialize();
            console.log('✅ 數據庫連接成功');
            
            // 啟動區塊鏈監聽器
            await this.startBlockchainListener();
            
            console.log('🚀 即時數據監聽器啟動完成');
            
        } catch (error) {
            console.error('❌ 即時數據監聽器初始化失敗:', error);
            throw error;
        }
    }


    async startBlockchainListener() {
        if (this.isConnected) {
            console.log('⚠️ 區塊鏈監聽器已在運行');
            return;
        }

        try {
            console.log('🔗 開始連接區塊鏈...');
            
            // ⚠️⚠️⚠️ 【🔥嚴重警告🔥】：絕對禁止更改此RPC節點！⚠️⚠️⚠️
            // 這是高級drpc.org節點，每秒可處理20000請求，極其穩定昂貴
            // 如有連接問題，請檢查監聽邏輯，絕對不准修改節點URL
            // 🔥🔥🔥 任何人擅自修改此節點URL將承擔嚴重後果！🔥🔥🔥
            // 🚨🚨🚨 此警告不得刪除、修改或忽視！🚨🚨🚨
            // ⚠️⚠️⚠️ 【🔥嚴重警告🔥】：絕對禁止更改此RPC節點！⚠️⚠️⛔
            this.provider = new ethers.WebSocketProvider('wss://lb.drpc.org/bsc/Ahc3I-33qkfGuwXSahR3XfPDRmd6WZsR8JbErqRhf0fE');
            this.contract = new ethers.Contract('0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA', require('./abi.json'), this.provider);
            
            // 設置連接事件監聽
            this.provider.websocket.on('open', () => {
                console.log('✅ 區塊鏈WebSocket連接成功');
                this.isConnected = true;
                
                // 通過數據庫通知連接狀態
                this.db.notify('realtime_status', JSON.stringify({
                    type: 'connection_status',
                    connected: true,
                    timestamp: new Date().toISOString()
                }));
            });
            
            this.provider.websocket.on('close', (code, reason) => {
                console.log(`❌ 區塊鏈WebSocket連接關閉: ${code} - ${reason}`);
                this.isConnected = false;
                
                // 通過數據庫通知連接狀態
                this.db.notify('realtime_status', JSON.stringify({
                    type: 'connection_status',
                    connected: false,
                    timestamp: new Date().toISOString()
                }));
                
                this.scheduleReconnect();
            });
            
            this.provider.websocket.on('error', (error) => {
                console.error('❌ 區塊鏈WebSocket錯誤:', error);
                this.isConnected = false;
                
                // 通過數據庫通知連接狀態
                this.db.notify('realtime_status', JSON.stringify({
                    type: 'connection_status',
                    connected: false,
                    timestamp: new Date().toISOString()
                }));
                
                this.scheduleReconnect();
            });
            
            // 等待連接建立
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('連接超時'));
                }, MONITORING_CONSTANTS.CONNECTION_TIMEOUT);
                
                this.provider.websocket.on('open', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                
                this.provider.websocket.on('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });
            
            // 獲取當前局次和鎖倉時間
            const currentEpoch = await this.contract.currentEpoch();
            this.currentRound = currentEpoch.toString();
            
            const round = await this.contract.rounds(currentEpoch);
            this.currentLockTimestamp = Number(round.lockTimestamp);
            
            console.log(`📍 當前局次: ${this.currentRound}, 鎖倉時間: ${this.currentLockTimestamp}`);
            
            // 設置事件監聽器
            this.setupEventListeners();
            
            // 通過數據庫通知當前局次信息
            await this.db.notify('realtime_status', JSON.stringify({
                type: 'round_update',
                epoch: this.currentRound,
                lockTimestamp: this.currentLockTimestamp,
                timestamp: new Date().toISOString()
            }));
            
        } catch (error) {
            console.error('❌ 區塊鏈監聽器啟動失敗:', error);
            this.isConnected = false;
            this.scheduleReconnect();
        }
    }

    setupEventListeners() {
        if (!this.contract) return;
        
        // 移除現有監聽器以避免重複
        this.contract.removeAllListeners();
        
        // 監聽區塊鏈下注事件 - 使用正確的事件監聽方式
        this.contract.on('BetBull', async (...args) => {
            // 在 ethers.js v6 中，最後一個參數是事件對象
            const event = args[args.length - 1];
            const [sender, epoch, amount] = args;
            
            console.log(`📈 BetBull事件 - 局次:${epoch}, 金額:${ethers.formatEther(amount)}, 發送者:${sender}`);
            console.log(`📈 事件詳情 - TxHash:${event.transactionHash}, Block:${event.blockNumber}`);
            await this.handleBet(sender, epoch, amount, event, 'UP', '📈');
        });
        
        this.contract.on('BetBear', async (...args) => {
            // 在 ethers.js v6 中，最後一個參數是事件對象
            const event = args[args.length - 1];
            const [sender, epoch, amount] = args;
            
            console.log(`📉 BetBear事件 - 局次:${epoch}, 金額:${ethers.formatEther(amount)}, 發送者:${sender}`);
            console.log(`📉 事件詳情 - TxHash:${event.transactionHash}, Block:${event.blockNumber}`);
            await this.handleBet(sender, epoch, amount, event, 'DOWN', '📉');
        });
        
        this.contract.on('StartRound', async (epoch) => {
            console.log('🚀 新局開始:', epoch.toString());
            console.log(`   前一局: ${this.currentRound} → 新局: ${epoch.toString()}`);
            
            this.currentRound = epoch.toString();
            
            // 獲取新局次的鎖倉時間
            try {
                const round = await this.contract.rounds(epoch);
                this.currentLockTimestamp = Number(round.lockTimestamp);
                console.log(`   鎖倉時間: ${this.currentLockTimestamp} (${new Date(this.currentLockTimestamp * 1000).toLocaleString()})`);
                
                const broadcastData = { 
                    type: 'round_start', 
                    epoch: this.currentRound,
                    lockTimestamp: this.currentLockTimestamp
                };
                
                console.log('📡 通知新局開始:', broadcastData);
                await this.db.notify('realtime_status', JSON.stringify({
                    ...broadcastData,
                    timestamp: new Date().toISOString()
                }));
            } catch (error) {
                console.error('❌ 獲取新局鎖倉時間失敗:', error);
            }
        });
        
        this.contract.on('LockRound', async (epoch) => {
            console.log('🔒 局次鎖倉:', epoch.toString());
            await this.db.notify('realtime_status', JSON.stringify({
                type: 'round_lock', 
                epoch: epoch.toString(),
                timestamp: new Date().toISOString()
            }));
        });
        
        console.log('✅ 事件監聽器設置完成');
    }

    createBetData(sender, epoch, amount, event, direction) {
        const betData = {
            epoch: epoch.toString(),
            bet_ts: new Date(),
            wallet_address: sender,
            bet_direction: direction,
            amount: ethers.formatEther(amount),
            tx_hash: event.transactionHash,
            block_number: event.blockNumber
        };
        
        console.log(`✅ 下注數據創建完成 - TxHash: ${betData.tx_hash}`);
        return betData;
    }

    async handleSuspiciousActivity(sender, suspiciousCheck, epoch, direction, amount) {
        console.log(`🚨 檢測到可疑錢包活動!`);
        console.log(`   錢包地址: ${sender}`);
        console.log(`   可疑標記: ${suspiciousCheck.flags.join(', ')}`);
        console.log(`   總下注次數: ${suspiciousCheck.totalBets}`);
        console.log(`   總下注金額: ${suspiciousCheck.totalAmount.toFixed(4)} BNB`);
        
        // 檢查是否已在數據庫中標記
        try {
            const existingNote = await this.db.getWalletNote(sender);
            if (!existingNote) {
                // 自動標記可疑錢包
                const suspiciousNote = `🚨 自動檢測可疑活動: ${suspiciousCheck.flags.join(', ')} | 檢測時間: ${new Date().toLocaleString()}`;
                await this.db.updateWalletNote(sender, suspiciousNote);
                console.log(`✅ 已自動標記可疑錢包: ${sender}`);
            }
        } catch (error) {
            console.error('❌ 標記可疑錢包失敗:', error);
        }
        
        // 通過數據庫通知可疑活動警報
        await this.db.notify('realtime_status', JSON.stringify({
            type: 'suspicious_activity',
            wallet: sender,
            epoch: epoch.toString(),
            direction,
            amount: amount,
            flags: suspiciousCheck.flags,
            totalBets: suspiciousCheck.totalBets,
            totalAmount: suspiciousCheck.totalAmount,
            timestamp: this.formatTimestamp(new Date())
        }));
    }

    async saveBetToDatabase(betData, sender, epoch, direction, amount, suspiciousCheck) {
        try {
            // 存入realbets表
            await this.db.insertRealBet(betData);
            console.log(`✅ 已存入數據庫: ${betData.tx_hash}`);
            
            // 🔔 發送PostgreSQL通知，告知有新的下注數據
            const notificationData = {
                type: 'new_bet',
                wallet: sender,
                epoch: epoch.toString(),
                direction,
                amount: amount,
                timestamp: this.formatTimestamp(new Date()),
                suspicious: suspiciousCheck.isSuspicious,
                suspiciousFlags: suspiciousCheck.isSuspicious ? suspiciousCheck.flags : undefined,
                tx_hash: betData.tx_hash
            };
            
            await this.db.notify('new_bet_data', JSON.stringify(notificationData));
            console.log(`📡 已通知數據庫監聽器: ${betData.tx_hash}`);
            
        } catch (error) {
            console.error('❌ 處理下注失敗:', error);
        }
    }

    async handleBet(sender, epoch, amount, event, direction, emoji) {
        const betData = this.createBetData(sender, epoch, amount, event, direction);
        
        console.log(`${emoji} ${direction}下注 局次${epoch}:`, betData.amount, 'BNB');
        
        // 🔍 可疑錢包檢查
        const suspiciousCheck = this.suspiciousMonitor.checkSuspiciousWallet(
            sender, 
            betData.amount, 
            epoch.toString()
        );
        
        if (suspiciousCheck.isSuspicious) {
            await this.handleSuspiciousActivity(sender, suspiciousCheck, epoch, direction, betData.amount);
        }
        
        await this.saveBetToDatabase(betData, sender, epoch, direction, betData.amount, suspiciousCheck);
    }


    scheduleReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        
        this.reconnectTimer = setTimeout(() => {
            console.log('🔄 嘗試重新連接區塊鏈...');
            this.startBlockchainListener();
        }, MONITORING_CONSTANTS.RECONNECT_DELAY);
    }

    // 🕐 統一時間格式化器 - 只顯示年月日時分秒
    formatTimestamp(timestamp) {
        return TimeUtils.formatTimestamp(timestamp);
    }

    // 獲取當前狀態
    getStatus() {
        return {
            isConnected: this.isConnected,
            currentRound: this.currentRound,
            currentLockTimestamp: this.currentLockTimestamp,
            suspiciousWallets: this.suspiciousMonitor.getSuspiciousWallets()
        };
    }

    // 檢查連接狀態
    getConnectionStatus() {
        return this.isConnected;
    }

    cleanup() {
        if (this.contract) {
            this.contract.removeAllListeners();
        }
        if (this.provider) {
            this.provider.destroy();
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        this.isConnected = false;
        console.log('✅ 即時數據監聽器已清理');
    }
}

// 如果直接運行此文件
if (require.main === module) {
    const listener = new RealtimeListener();
    
    // 優雅關閉處理
    process.on('SIGINT', () => {
        console.log('\n🛑 接收到關閉信號，正在清理資源...');
        listener.cleanup();
        process.exit(0);
    });
    
    process.on('SIGTERM', () => {
        console.log('\n🛑 接收到終止信號，正在清理資源...');
        listener.cleanup();
        process.exit(0);
    });
    
    listener.initialize().catch(error => {
        console.error('❌ 啟動失敗:', error);
        process.exit(1);
    });
}

module.exports = RealtimeListener;