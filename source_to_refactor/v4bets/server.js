const express = require('express');
const { Client } = require('pg');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

class Server {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        this.clients = new Set();
        this.db = null;
        this.dbListener = null;
        
        this.setupRoutes();
        this.setupWebSocket();
    }

    setupRoutes() {
        this.app.use(express.static('.'));
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'index.html'));
        });
        
        // API: 獲取最新下注數據
        this.app.get('/api/recent-bets', async (req, res) => {
            try {
                const result = await this.db.query(`
                    SELECT epoch, bet_ts, wallet_address, bet_direction, amount, tx_hash
                    FROM realbets 
                    ORDER BY bet_ts DESC 
                    LIMIT 50
                `);
                res.json({ success: true, bets: result.rows });
            } catch (error) {
                res.json({ success: false, error: error.message });
            }
        });

        // API: 獲取當前局次狀態
        this.app.get('/api/realtime-status', async (req, res) => {
            try {
                const result = await this.db.query(`
                    SELECT epoch 
                    FROM realbets 
                    ORDER BY bet_ts DESC 
                    LIMIT 1
                `);
                const currentRound = result.rows.length > 0 ? result.rows[0].epoch : null;
                res.json({ 
                    success: true, 
                    isConnected: true,
                    currentRound: currentRound,
                    currentLockTimestamp: null,
                    suspiciousWallets: []
                });
            } catch (error) {
                res.json({ success: false, error: error.message });
            }
        });

        // API: 獲取指定局次的所有下注數據
        this.app.get('/api/round-data/:epoch', async (req, res) => {
            try {
                const epoch = req.params.epoch;
                const result = await this.db.query(`
                    SELECT epoch, bet_ts, wallet_address, bet_direction, amount, tx_hash
                    FROM realbets 
                    WHERE epoch = $1
                    ORDER BY bet_ts ASC
                `, [epoch]);
                
                const formattedBets = result.rows.map(bet => ({
                    epoch: bet.epoch,
                    timestamp: bet.bet_ts.toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'}),
                    wallet: bet.wallet_address,
                    direction: bet.bet_direction,
                    amount: parseFloat(bet.amount),
                    tx_hash: bet.tx_hash,
                    source: 'realtime'
                }));

                res.json({ 
                    success: true,
                    epoch: epoch,
                    bets: formattedBets,
                    source: 'realtime',
                    message: `即時數據 (${formattedBets.length} 筆下注)`
                });
            } catch (error) {
                res.json({ success: false, error: error.message });
            }
        });

        // SSE: 即時下注數據流
        this.app.get('/api/live-bets', (req, res) => {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });

            console.log('📡 SSE客戶端連接');
            this.sseClients = this.sseClients || new Set();
            this.sseClients.add(res);

            res.write('data: {"type":"connected"}\n\n');

            req.on('close', () => {
                console.log('❌ SSE客戶端斷開');
                this.sseClients.delete(res);
            });
        });
    }

    setupWebSocket() {
        this.wss.on('connection', (ws) => {
            console.log('🔗 WebSocket連接');
            this.clients.add(ws);
            
            ws.on('close', () => {
                console.log('❌ WebSocket斷開');
                this.clients.delete(ws);
            });
        });
    }

    async connectDatabase() {
        this.db = new Client({
            connectionString: 'postgresql://neondb_owner:npg_vXlY01CQdqTh@ep-billowing-smoke-a13osu4w-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require&timezone=Asia/Taipei'
        });
        
        await this.db.connect();
        console.log('✅ 數據庫連接成功');
        
        // 創建監聽客戶端
        this.dbListener = new Client({
            connectionString: 'postgresql://neondb_owner:npg_vXlY01CQdqTh@ep-billowing-smoke-a13osu4w-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require&timezone=Asia/Taipei'
        });
        
        await this.dbListener.connect();
        
        // 監聽數據庫通知
        await this.dbListener.query('LISTEN new_bet_data');
        
        this.dbListener.on('notification', async (msg) => {
            console.log('📡 收到數據庫通知');
            try {
                const notificationData = JSON.parse(msg.payload);
                
                // 如果是新下注通知，直接查詢並推送完整數據
                if (notificationData.type === 'new_bet') {
                    const betData = {
                        type: 'new_bet',
                        epoch: notificationData.epoch,
                        timestamp: new Date().toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'}),
                        wallet: notificationData.wallet,
                        direction: notificationData.direction,
                        amount: parseFloat(notificationData.amount),
                        tx_hash: notificationData.tx_hash,
                        source: 'realtime'
                    };
                    
                    console.log(`📊 推送新下注: ${betData.wallet} ${betData.direction} ${betData.amount}BNB`);
                    this.broadcastSSE(betData);
                    this.broadcast(betData);
                }
            } catch (error) {
                console.error('❌ 解析通知失敗:', error);
            }
        });
        
        console.log('👂 開始監聽數據庫通知');
    }

    broadcast(data) {
        if (this.clients.size === 0) return;
        
        const message = JSON.stringify(data);
        let sent = 0;
        
        this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
                sent++;
            }
        });
        
        console.log(`📤 WebSocket廣播給 ${sent} 個客戶端`);
    }

    broadcastSSE(data) {
        if (!this.sseClients || this.sseClients.size === 0) return;
        
        const message = `data: ${JSON.stringify(data)}\n\n`;
        let sent = 0;
        const deadClients = [];
        
        this.sseClients.forEach(client => {
            try {
                client.write(message);
                sent++;
            } catch (error) {
                deadClients.push(client);
            }
        });
        
        // 清理失效連接
        deadClients.forEach(client => {
            this.sseClients.delete(client);
        });
        
        console.log(`📡 SSE推送給 ${sent} 個客戶端`);
    }

    async start(port = 3000) {
        try {
            await this.connectDatabase();
            
            this.server.listen(port, () => {
                console.log(`🚀 服務器運行在 http://localhost:${port}`);
            });
        } catch (error) {
            console.error('❌ 啟動失敗:', error);
            process.exit(1);
        }
    }

    cleanup() {
        if (this.db) this.db.end();
        if (this.dbListener) this.dbListener.end();
        console.log('✅ 服務器已清理');
    }
}

// 啟動服務器
const server = new Server();

process.on('SIGINT', () => {
    console.log('\n🛑 正在關閉服務器...');
    server.cleanup();
    process.exit(0);
});

server.start(3000);

module.exports = Server;