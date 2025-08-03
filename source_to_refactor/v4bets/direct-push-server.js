const { ethers } = require('ethers');
const WebSocket = require('ws');
const Database = require('./database');
const fs = require('fs');

/**
 * 即時數據推送伺服器
 * 實現區塊鏈事件直接推送給前端，繞過PostgreSQL通知機制
 * 創建時間：2024年收到核准後立即創建
 */

class DirectPushServer {
    constructor(config) {
        this.config = {
            port: config.port || 8080,
            rpcUrl: config.rpcUrl || 'wss://bsc-dataseed.binance.org/ws',
            contractAddress: config.contractAddress,
            privateKey: config.privateKey,
            ...config
        };
        
        this.db = new Database();
        this.wss = null;
        this.provider = null;
        this.contract = null;
        this.clients = new Set();
        
        // 日誌記錄
        this.logFile = './direct-push-log.txt';
        this.log('DirectPushServer 初始化完成');
    }

    /**
     * 日誌記錄函式
     * 記錄所有重要操作和事件
     */
    log(message) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${message}\n`;
        
        console.log(logEntry.trim());
        
        try {
            fs.appendFileSync(this.logFile, logEntry);
        } catch (error) {
            console.error('日誌寫入失敗:', error.message);
        }
    }

    /**
     * 初始化WebSocket伺服器
     * 建立與前端的直接連接
     */
    async initializeWebSocketServer() {
        return new Promise((resolve, reject) => {
            try {
                this.wss = new WebSocket.Server({ port: this.config.port });
                
                this.wss.on('connection', (ws) => {
                    this.log(`新客戶端連接: ${ws._socket.remoteAddress}`);
                    this.clients.add(ws);
                    
                    ws.on('close', () => {
                        this.log(`客戶端斷開連接: ${ws._socket.remoteAddress}`);
                        this.clients.delete(ws);
                    });
                    
                    ws.on('error', (error) => {
                        this.log(`WebSocket錯誤: ${error.message}`);
                        this.clients.delete(ws);
                    });
                });
                
                this.wss.on('listening', () => {
                    this.log(`WebSocket伺服器啟動在端口 ${this.config.port}`);
                    resolve();
                });
                
                this.wss.on('error', (error) => {
                    this.log(`WebSocket伺服器錯誤: ${error.message}`);
                    reject(error);
                });
                
            } catch (error) {
                this.log(`初始化WebSocket伺服器失敗: ${error.message}`);
                reject(error);
            }
        });
    }

    /**
     * 初始化區塊鏈連接
     * 建立與BSC網絡的WebSocket連接
     */
    async initializeBlockchainConnection() {
        try {
            this.provider = new ethers.WebSocketProvider(this.config.rpcUrl);
            
            const abi = require('./abi.json');
            this.contract = new ethers.Contract(
                this.config.contractAddress,
                abi,
                this.provider
            );
            
            this.log('區塊鏈連接初始化完成');
            
            // 監聽連接狀態
            this.provider.websocket.on('close', () => {
                this.log('區塊鏈連接斷開，嘗試重新連接...');
                setTimeout(() => this.reconnectBlockchain(), 5000);
            });
            
            this.provider.websocket.on('error', (error) => {
                this.log(`區塊鏈連接錯誤: ${error.message}`);
            });
            
        } catch (error) {
            this.log(`初始化區塊鏈連接失敗: ${error.message}`);
            throw error;
        }
    }

    /**
     * 重新連接區塊鏈
     * 處理連接中斷的自動重連
     */
    async reconnectBlockchain() {
        try {
            this.log('開始重新連接區塊鏈...');
            await this.initializeBlockchainConnection();
            this.startListening();
            this.log('區塊鏈重新連接成功');
        } catch (error) {
            this.log(`重新連接失敗: ${error.message}`);
            setTimeout(() => this.reconnectBlockchain(), 10000);
        }
    }

    /**
     * 廣播數據給所有連接的客戶端
     * 實現毫秒級的即時推送
     */
    broadcast(data) {
        const message = JSON.stringify({
            type: 'realtime_bet',
            timestamp: Date.now(),
            data: data
        });
        
        let sentCount = 0;
        this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
                sentCount++;
            }
        });
        
        this.log(`廣播數據給 ${sentCount} 個客戶端: ${data.eventType} - ${data.walletAddress}`);
    }

    /**
     * 處理下注事件
     * 接收區塊鏈事件並立即推送
     */
    async handleBetEvent(eventType, event) {
        try {
            const betData = {
                eventType: eventType,
                epoch: Number(event.args.epoch),
                walletAddress: event.args.player,
                amount: ethers.formatEther(event.args.amount),
                txHash: event.transactionHash,
                blockNumber: event.blockNumber,
                timestamp: Date.now()
            };
            
            // 立即推送給前端
            this.broadcast(betData);
            
            // 同時儲存到數據庫（非同步進行，不阻塞推送）
            this.saveToDatabase(betData);
            
        } catch (error) {
            this.log(`處理下注事件錯誤: ${error.message}`);
        }
    }

    /**
     * 儲存數據到數據庫
     * 保持數據持久化，不影響即時推送
     */
    async saveToDatabase(betData) {
        try {
            await this.db.insertRealBet({
                epoch: betData.epoch,
                wallet_address: betData.walletAddress,
                amount: betData.amount,
                bet_type: betData.eventType === 'BetBull' ? 'bull' : 'bear',
                tx_hash: betData.txHash,
                block_number: betData.blockNumber,
                timestamp: new Date(betData.timestamp)
            });
            
            this.log(`數據已儲存到數據庫: ${betData.walletAddress}`);
            
        } catch (error) {
            this.log(`儲存數據庫錯誤: ${error.message}`);
        }
    }

    /**
     * 開始監聽區塊鏈事件
     * 建立事件監聽器
     */
    startListening() {
        try {
            this.contract.on('BetBull', (epoch, player, amount, event) => {
                this.handleBetEvent('BetBull', event);
            });
            
            this.contract.on('BetBear', (epoch, player, amount, event) => {
                this.handleBetEvent('BetBear', event);
            });
            
            this.log('開始監聽區塊鏈下注事件');
            
        } catch (error) {
            this.log(`建立事件監聽器錯誤: ${error.message}`);
            throw error;
        }
    }

    /**
     * 啟動服務
     * 初始化所有組件並開始運行
     */
    async start() {
        try {
            this.log('=== DirectPushServer 啟動中 ===');
            
            await this.initializeWebSocketServer();
            await this.initializeBlockchainConnection();
            await this.startListening();
            
            this.log('=== DirectPushServer 啟動完成 ===');
            
        } catch (error) {
            this.log(`啟動失敗: ${error.message}`);
            throw error;
        }
    }

    /**
     * 停止服務
     * 清理資源並關閉連接
     */
    async stop() {
        this.log('=== DirectPushServer 停止中 ===');
        
        if (this.wss) {
            this.wss.close();
            this.log('WebSocket伺服器已關閉');
        }
        
        if (this.contract) {
            this.contract.removeAllListeners();
            this.log('事件監聽器已移除');
        }
        
        if (this.provider && this.provider.websocket) {
            this.provider.websocket.terminate();
            this.log('區塊鏈連接已關閉');
        }
        
        this.log('=== DirectPushServer 已停止 ===');
    }
}

// 導出供其他模組使用
module.exports = DirectPushServer;

// 如果直接運行此檔案
if (require.main === module) {
    const config = {
        port: process.env.WS_PORT || 8080,
        rpcUrl: process.env.RPC_URL || 'wss://bsc-dataseed.binance.org/ws',
        contractAddress: process.env.CONTRACT_ADDRESS,
        privateKey: process.env.PRIVATE_KEY
    };
    
    const server = new DirectPushServer(config);
    
    server.start().catch(error => {
        console.error('啟動失敗:', error);
        process.exit(1);
    });
    
    // 處理程序終止
    process.on('SIGTERM', () => server.stop());
    process.on('SIGINT', () => server.stop());
}