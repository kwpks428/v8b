const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const Database = require('./database');
const ClaimsAnalyzer = require('./claims-analyzer');
const RealtimeListener = require('./realtime-listener');

class TrunkServer {
    constructor(options = {}) {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        this.db = new Database();
        this.clients = new Set(); // 初始化客戶端集合
        this.claimsAnalyzer = new ClaimsAnalyzer(); // 初始化claims分析器
        
        // 可選的即時監聽器
        this.realtimeListener = options.enableRealtimeListener ? new RealtimeListener() : null;
        this.currentRound = null;
        this.currentLockTimestamp = null;
        this.isConnected = false;
        
        // 數據庫監聽客戶端
        this.dbListenerClient = null;
        
        this.setupRoutes();
        this.setupWebSocket();
        this.setupDatabaseListener(); // 設置數據庫監聽
    }

    async start(port = 3000) {
        try {
            await this.db.initialize();
            console.log('✅ 數據庫連接成功');
            
            // 初始化claims分析器
            await this.claimsAnalyzer.initialize();
            console.log('✅ Claims分析器初始化完成');
            
            // 執行初次claims分析
            await this.performInitialClaimsAnalysis();
            
            // 如果啟用了即時監聽器，初始化並設置數據庫監聽
            if (this.realtimeListener) {
                await this.realtimeListener.initialize();
                await this.setupDatabaseListener();
                console.log('✅ 即時監聽器已啟動並連接');
            }
            
            this.server.listen(port, () => {
                console.log(`🚀 Trunk服務器運行在 http://localhost:${port}`);
                if (this.realtimeListener) {
                    console.log('📡 已集成即時數據監聽器');
                } else {
                    console.log('📚 純API模式（無即時監聽）');
                }
            });
            
        } catch (error) {
            console.error('❌ 服務器啟動失敗:', error);
            process.exit(1);
        }
    }

    // 🔍 執行初次claims分析
    async performInitialClaimsAnalysis() {
        try {
            console.log('🔍 開始執行初次claims分析...');
            const analysis = await this.claimsAnalyzer.analyzeSuspiciousClaims();
            const report = this.claimsAnalyzer.generateSuspiciousClaimsReport();
            
            console.log('📊 Claims分析完成:');
            console.log(`   可疑錢包數量: ${analysis.total_suspicious_wallets}`);
            console.log(`   可疑記錄數量: ${analysis.suspicious_records}`);
            console.log(`   風險分布: HIGH=${report.risk_distribution.HIGH}, MEDIUM=${report.risk_distribution.MEDIUM}, LOW=${report.risk_distribution.LOW}`);
            
            // 保存分析結果
            await this.claimsAnalyzer.saveAnalysisResults();
            
        } catch (error) {
            console.error('❌ 初次claims分析失敗:', error);
        }
    }

    // 🎯 處理來自即時監聽器的數據
    handleRealtimeData(data) {
        console.log('📡 收到即時數據:', data.type);
        
        // 更新當前狀態
        if (data.type === 'round_update' || data.type === 'round_start') {
            this.currentRound = data.epoch;
            this.currentLockTimestamp = data.lockTimestamp;
        }
        
        if (data.type === 'connection_status') {
            this.isConnected = data.connected;
        }
        
        // 廣播給所有WebSocket客戶端
        this.broadcast(data);
    }

    // 🔔 設置數據庫監聽器 - 監聽即時數據更新
    async setupDatabaseListener() {
        try {
            console.log('🔔 設置數據庫監聽器...');
            
            // 監聽新的下注數據
            this.dbListenerClient = await this.db.listen('new_bet_data', (data) => {
                console.log('📡 收到下注數據通知:', data.type);
                
                // 更新當前狀態（如果包含局次信息）
                if (data.epoch) {
                    this.currentRound = data.epoch;
                }
                
                // 立即廣播給前端
                this.broadcast(data);
            });
            
            // 監聽即時狀態更新（連接狀態、新局開始、鎖倉等）
            await this.db.listen('realtime_status', (data) => {
                console.log('📡 收到狀態通知:', data.type);
                
                // 更新內部狀態
                if (data.type === 'connection_status') {
                    this.isConnected = data.connected;
                } else if (data.type === 'round_update' || data.type === 'round_start') {
                    this.currentRound = data.epoch;
                    this.currentLockTimestamp = data.lockTimestamp;
                }
                
                // 廣播給前端
                this.broadcast(data);
            });
            
            console.log('✅ 數據庫監聽器設置完成 (new_bet_data + realtime_status)');
            
        } catch (error) {
            console.error('❌ 設置數據庫監聽器失敗:', error);
        }
    }

    setupRoutes() {
        this.app.use(express.static('.'));
        this.app.use(express.json());
        
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'index.html'));
        });
        
        this.app.get('/monitor', (req, res) => {
            res.sendFile(path.join(__dirname, 'suspicious-monitor.html'));
        });
        
        // 🎯 智能數據源API - 實現無縫接軋策略
        this.app.get('/api/round-data/:epoch', this.handleRequest(async (req) => {
            const epoch = req.params.epoch;
            return await this.getSmartRoundData(epoch);
        }));
        
        // 📊 錢包48局歷史結果API - 獲取指定錢包的勝負記錄
        this.app.get('/api/wallet-history/:wallet/:startEpoch', this.handleRequest(async (req) => {
            const wallet = req.params.wallet;
            const startEpoch = parseInt(req.params.startEpoch);
            return await this.getWallet48RoundResults(wallet, startEpoch);
        }));
        
        // 📝 錢包備註API - 獲取錢包備註
        this.app.get('/api/wallet-note/:wallet', this.handleRequest(async (req) => {
            const wallet = req.params.wallet;
            return await this.getWalletNote(wallet);
        }));
        
        // 🚨 可疑錢包監控API
        this.app.get('/api/suspicious-wallets', this.handleRequest(async () => {
            if (this.realtimeListener) {
                const status = this.realtimeListener.getStatus();
                const walletDetails = [];
                
                for (const wallet of status.suspiciousWallets) {
                    const note = await this.db.getWalletNote(wallet);
                    walletDetails.push({
                        wallet,
                        note: note ? note.note : null,
                        markedAt: note ? note.updated_at : null
                    });
                }
                
                return {
                    count: status.suspiciousWallets.length,
                    wallets: walletDetails
                };
            } else {
                return {
                    count: 0,
                    wallets: [],
                    message: '即時監聽器未啟用，無法獲取可疑錢包數據'
                };
            }
        }));
        
        // 🔍 錢包監控統計API
        this.app.get('/api/wallet-stats/:wallet', this.handleRequest(async (req) => {
            const wallet = req.params.wallet;
            
            if (this.realtimeListener) {
                const status = this.realtimeListener.getStatus();
                const isSuspicious = status.suspiciousWallets.includes(wallet);
                
                return {
                    wallet,
                    totalBets: 'N/A', // 即時監聽器模式下暫不提供
                    totalAmount: 'N/A', // 即時監聽器模式下暫不提供
                    isSuspicious,
                    note: await this.db.getWalletNote(wallet),
                    message: '統計數據由即時監聽器提供'
                };
            } else {
                return {
                    wallet,
                    totalBets: 0,
                    totalAmount: '0.0000',
                    isSuspicious: false,
                    note: await this.db.getWalletNote(wallet),
                    message: '即時監聽器未啟用'
                };
            }
        }));
        
        this.app.get('/api/latest-round', this.handleRequest(async () => {
            return { epoch: this.currentRound ? parseInt(this.currentRound) : null };
        }));
        
        // 🔍 Claims分析API
        this.app.get('/api/claims-analysis', this.handleRequest(async () => {
            const report = this.claimsAnalyzer.generateSuspiciousClaimsReport();
            return {
                analysis_report: report,
                suspicious_wallets: Array.from(this.claimsAnalyzer.suspiciousWallets)
            };
        }));
        
        // 🎯 檢查特定錢包是否可疑
        this.app.get('/api/check-suspicious/:wallet', this.handleRequest(async (req) => {
            const wallet = req.params.wallet;
            const isSuspicious = this.claimsAnalyzer.isSuspiciousWallet(wallet);
            const details = this.claimsAnalyzer.getSuspiciousWalletDetails(wallet);
            
            return {
                wallet,
                is_suspicious: isSuspicious,
                details: details,
                note: await this.db.getWalletNote(wallet)
            };
        }));
        
        // 📊 分析特定局次的可疑活動
        this.app.get('/api/epoch-suspicious/:epoch', this.handleRequest(async (req) => {
            const epoch = req.params.epoch;
            const suspiciousActivity = await this.claimsAnalyzer.analyzeEpochSuspiciousActivity(epoch);
            
            return {
                epoch,
                suspicious_count: suspiciousActivity.length,
                suspicious_wallets: suspiciousActivity
            };
        }));
        
        // 🔄 更新可疑錢包列表
        this.app.post('/api/update-suspicious-wallets', this.handleRequest(async () => {
            const updateResult = await this.claimsAnalyzer.updateSuspiciousWalletsList();
            return updateResult;
        }));
        
        // 🔍 獲取即時監聽器狀態API
        this.app.get('/api/realtime-status', this.handleRequest(async () => {
            if (this.realtimeListener) {
                return this.realtimeListener.getStatus();
            } else {
                return {
                    isConnected: false,
                    currentRound: null,
                    currentLockTimestamp: null,
                    suspiciousWallets: [],
                    suspiciousClaimsWallets: [],
                    message: '即時監聽器未啟用'
                };
            }
        }));
    }

    handleRequest(handler) {
        return async (req, res) => {
            try {
                const result = await handler(req, res);
                res.json({ success: true, ...result });
            } catch (error) {
                console.error('❌ API 請求失敗:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        };
    }

    setupWebSocket() {
        this.wss.on('connection', async (ws) => {
            console.log('🔗 新的 WebSocket 連接');
            
            // 添加到客戶端集合
            this.clients.add(ws);
            
            // 設置心跳機制
            ws.isAlive = true;
            ws.on('pong', () => {
                ws.isAlive = true;
            });
            
            // 發送當前局次信息 - 總是從即時監聽器獲取最新狀態
            if (this.realtimeListener) {
                try {
                    const status = this.realtimeListener.getStatus();
                    if (status.currentRound) {
                        // 更新服務器狀態為最新
                        this.currentRound = status.currentRound;
                        this.currentLockTimestamp = status.currentLockTimestamp;
                        
                        ws.send(JSON.stringify({
                            type: 'round_update',
                            epoch: this.currentRound,
                            lockTimestamp: this.currentLockTimestamp
                        }));
                        console.log(`📡 發送最新局次給新客戶端: ${this.currentRound}`);
                    } else {
                        console.log('⚠️ 即時監聽器尚未獲取到當前局次');
                    }
                } catch (error) {
                    console.error('❌ 獲取即時監聽器狀態失敗:', error);
                }
            } else if (this.currentRound) {
                // 備用方案：使用服務器緩存的局次
                ws.send(JSON.stringify({
                    type: 'round_update',
                    epoch: this.currentRound,
                    lockTimestamp: this.currentLockTimestamp
                }));
                console.log(`📡 發送緩存局次給新客戶端: ${this.currentRound}`);
            }
            
            // 檢查實際的區塊鏈連接狀態
            const actualConnectionStatus = this.realtimeListener ? 
                this.realtimeListener.getConnectionStatus() : false;
            
            // 發送連接狀態
            ws.send(JSON.stringify({
                type: 'connection_status',
                connected: actualConnectionStatus
            }));
            
            ws.on('close', () => {
                console.log('❌ WebSocket 連接關閉');
                this.clients.delete(ws);
            });
            
            ws.on('error', (error) => {
                console.error('❌ WebSocket 錯誤:', error);
                this.clients.delete(ws);
            });
        });
        
        // 心跳檢查，每30秒檢查一次
        setInterval(() => {
            this.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    console.log('❌ 心跳逾時，關閉連接');
                    this.clients.delete(ws);
                    return ws.terminate();
                }
                
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);
    }

    broadcast(data) {
        if (!data || this.clients.size === 0) return;
        
        const message = JSON.stringify(data);
        let sentCount = 0;
        const deadConnections = [];
        
        this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(message);
                    sentCount++;
                } catch (error) {
                    console.error('❌ 發送消息失敗:', error);
                    deadConnections.push(client);
                }
            } else {
                deadConnections.push(client);
            }
        });
        
        // 清理失效連接
        deadConnections.forEach(client => {
            this.clients.delete(client);
        });
        
        if (sentCount > 0) {
            console.log(`📤 廣播消息給 ${sentCount}/${this.clients.size + deadConnections.length} 個客戶端:`, data.type);
        }
        if (deadConnections.length > 0) {
            console.log(`🧹 清理了 ${deadConnections.length} 個失效連接`);
        }
    }
    
    cleanup() {
        // 關閉即時監聽器
        if (this.realtimeListener) {
            this.realtimeListener.cleanup();
        }
        
        // 關閉claims分析器
        if (this.claimsAnalyzer) {
            this.claimsAnalyzer.close();
        }
        
        // 關閉數據庫監聽連接
        if (this.dbListenerClient) {
            this.dbListenerClient.release();
            console.log('🔔 數據庫監聽器已關閉');
        }
        
        console.log('✅ TrunkServer已清理');
    }

    // 🧠 智能數據獲取 - 實現「先realbets，後hisbets」的無縫策略
    async getSmartRoundData(epoch) {
        const epochStr = String(epoch);
        console.log(`🔍 智能查詢局次 ${epochStr} 數據`);
        
        try {
            // 步驟1: 優先查詢 realbets (最新2局的即時數據)
            console.log(`   📡 Step 1: 查詢 realbets...`);
            const realtimeBets = await this.db.getRealBetsByEpoch(epochStr);
            
            if (realtimeBets && realtimeBets.length > 0) {
                console.log(`   ✅ 在 realbets 找到 ${realtimeBets.length} 筆數據`);
                const formattedBets = this.formatBetsForDisplay(realtimeBets, 'realtime');
                return {
                    epoch: epochStr,
                    bets: formattedBets,
                    source: 'realtime',
                    message: `即時數據 (${realtimeBets.length} 筆下注)`
                };
            }
            
            // 步驟2: realbets無數據，查詢 hisbets (完整歷史數據)
            console.log(`   📚 Step 2: realbets無數據，查詢 hisbets...`);
            const historyBets = await this.db.getBetsByEpoch(epochStr);
            
            if (historyBets && historyBets.length > 0) {
                console.log(`   ✅ 在 hisbets 找到 ${historyBets.length} 筆數據`);
                // getBetsByEpoch已經格式化了，但需要修正source
                const correctedBets = historyBets.map(bet => ({
                    ...bet,
                    source: 'history'
                }));
                return {
                    epoch: epochStr,
                    bets: correctedBets,
                    source: 'history',
                    message: `歷史數據 (${historyBets.length} 筆下注)`
                };
            }
            
            // 步驟3: 兩個表都沒有數據
            console.log(`   ❌ 在 realbets 和 hisbets 都未找到局次 ${epochStr} 的數據`);
            return {
                epoch: epochStr,
                bets: [],
                source: 'none',
                message: '暫無數據'
            };
            
        } catch (error) {
            console.error(`❌ 智能查詢局次 ${epochStr} 失敗:`, error);
            throw error;
        }
    }
    
    // 📊 統一數據格式化器 - 支持多數據源
    formatBetsForDisplay(bets, sourceType = 'unknown') {
        if (!bets || bets.length === 0) return [];
        
        return bets.map(bet => ({
            epoch: bet.epoch,
            timestamp: this.formatTimestamp(bet.bet_ts),
            wallet: bet.wallet_address,
            direction: bet.bet_direction,
            amount: parseFloat(bet.amount),
            tx_hash: bet.tx_hash,
            source: sourceType
        }));
    }

    // 🎯 獲取指定錢包的48局歷史結果 - 個人化勝負記錄
    async getWallet48RoundResults(wallet, startEpoch) {
        console.log(`🎯 獲取錢包 ${wallet} 的48局歷史結果，起始局次: ${startEpoch}`);
        
        try {
            // 計算48局範圍：startEpoch 到 startEpoch-47
            const endEpoch = startEpoch - 47;
            console.log(`   查詢範圍: ${startEpoch} → ${endEpoch} (共48局)`);
            
            // 查詢指定錢包在指定範圍的歷史下注數據（hisbets表已包含WIN/LOSS結果）
            const walletBets = await this.db.getWalletHistoryBets(wallet, startEpoch, endEpoch);
            console.log(`   找到錢包 ${wallet} 的 ${walletBets.length} 筆下注記錄`);
            
            // 處理數據：按局次分組並分析個人勝負結果
            const results = await this.processWalletRoundResults(walletBets, startEpoch, endEpoch);
            
            return {
                wallet,
                startEpoch,
                endEpoch,
                totalRounds: 48,
                results: results,
                totalBets: walletBets.length,
                message: `錢包48局歷史 (${walletBets.length} 筆下注)`
            };
            
        } catch (error) {
            console.error(`❌ 獲取錢包48局歷史結果失敗:`, error);
            throw error;
        }
    }
    
    // 🔄 處理錢包局次結果數據 - 結合hisbets和rounds表判定WIN/LOSS
    async processWalletRoundResults(walletBets, startEpoch, endEpoch) {
        const results = [];
        
        console.log(`🔄 處理 ${startEpoch} → ${endEpoch} 錢包局次結果，共 ${walletBets.length} 筆下注記錄`);
        
        // 為每一局創建結果對象
        for (let epoch = startEpoch; epoch >= endEpoch; epoch--) {
            const epochBets = walletBets.filter(bet => parseInt(bet.epoch) === epoch);
            
            let result = null; // null表示無下注
            
            if (epochBets.length > 0) {
                const bet = epochBets[0]; // 一個錢包每局只能下注一次
                
                // 🎯 優先使用hisbets表中的result
                if (bet.result && (bet.result === 'WIN' || bet.result === 'LOSS')) {
                    result = bet.result;
                    console.log(`   局次 ${epoch}: 使用hisbets結果 ${result}`);
                } else {
                    // 🔍 如果hisbets沒有結果，查詢rounds表計算
                    try {
                        const roundData = await this.db.getRound(epoch);
                        if (roundData && roundData.result) {
                            // 比較下注方向和局次結果
                            const betDirection = bet.bet_direction; // 'UP' or 'DOWN'
                            const roundResult = roundData.result;  // 'UP' or 'DOWN'
                            
                            result = (betDirection === roundResult) ? 'WIN' : 'LOSS';
                            console.log(`   局次 ${epoch}: 從rounds表計算 ${betDirection} vs ${roundResult} = ${result}`);
                        } else {
                            console.log(`   局次 ${epoch}: rounds表無結果數據`);
                        }
                    } catch (error) {
                        console.log(`   局次 ${epoch}: 查詢rounds表失敗 - ${error.message}`);
                    }
                }
            }
            
            results.push({
                epoch: epoch,
                result: result,
                betsCount: epochBets.length,
                totalAmount: epochBets.length > 0 ? 
                    epochBets.reduce((sum, bet) => sum + parseFloat(bet.amount), 0) : 0,
                directions: epochBets.length > 0 ? 
                    [...new Set(epochBets.map(bet => bet.bet_direction))] : []
            });
        }
        
        const betsCount = results.filter(r => r.result !== null).length;
        const winCount = results.filter(r => r.result === 'WIN').length;
        const lossCount = results.filter(r => r.result === 'LOSS').length;
        console.log(`   ✅ 處理完成: ${results.length} 局，其中 ${betsCount} 局有下注 (${winCount}勝/${lossCount}負)`);
        return results;
    }
    
    // 📝 獲取錢包備註
    async getWalletNote(wallet) {
        console.log(`📝 獲取錢包備註: ${wallet}`);
        
        try {
            const note = await this.db.getWalletNote(wallet);
            return {
                wallet,
                note: note || '',
                message: note ? '找到備註' : '無備註'
            };
        } catch (error) {
            console.error(`❌ 獲取錢包備註失敗:`, error);
            throw error;
        }
    }

    // 🕐 統一時間格式化器 - 只顯示年月日時分秒
    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hour = String(date.getHours()).padStart(2, '0');
        const minute = String(date.getMinutes()).padStart(2, '0');
        const second = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
    }
}

// 如果直接運行此文件，則啟動集成模式（向後兼容）
if (require.main === module) {
    console.log('🚀 啟動TrunkServer (集成模式)...');
    console.log('💡 提示: 使用專用啟動腳本可獲得更多選項');
    
    const server = new TrunkServer({ 
        enableRealtimeListener: true // 默認啟用即時監聽器以保持兼容性
    });

    // 優雅關閉處理
    process.on('SIGINT', () => {
        console.log('\n🛑 接收到關閉信號，正在清理資源...');
        server.cleanup();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\n🛑 接收到終止信號，正在清理資源...');
        server.cleanup();
        process.exit(0);
    });

    server.start(3000);
}

module.exports = TrunkServer;