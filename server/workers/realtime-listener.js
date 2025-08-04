const { ethers } = require('ethers');
const WebSocket = require('ws');
const http = require('http');
const ConnectionManager = require('../db/ConnectionManager');
const TimeService = require('../services/TimeService');

class SuspiciousWalletMonitor {
    constructor() {
        this.walletBetCounts = new Map(); // Stores total bet count (number)
        this.recentBets = new Map();      // Stores recent bet timestamps (array)
        this.highFrequencyWindow = 60000;
        this.maxBetsInWindow = 10;
    }

    checkSuspiciousWallet(wallet, amount, epoch) {
        const now = Date.now();
        let flags = [];

        // Correctly handle total bet count
        const currentCount = (this.walletBetCounts.get(wallet) || 0) + 1;
        this.walletBetCounts.set(wallet, currentCount);

        // Correctly handle recent bets for high-frequency check
        const walletRecentBets = this.recentBets.get(wallet) || [];
        const validRecentBets = walletRecentBets.filter(time => now - time < this.highFrequencyWindow);
        validRecentBets.push(now);
        this.recentBets.set(wallet, validRecentBets);

        if (validRecentBets.length > this.maxBetsInWindow) {
            flags.push(`High frequency betting: ${validRecentBets.length} bets in the last minute.`);
        }

        return { isSuspicious: flags.length > 0, flags };
    }
}

class RealtimeListener {
    constructor(port = 3010) {
        this.connectionManager = ConnectionManager;
        this.suspiciousMonitor = new SuspiciousWalletMonitor();
        this.processedBets = new Map();
        this.wsPort = port;
        this.wss = null;
        this.connectedClients = new Set();
    }

    async initialize() {
        try {
            console.log('🔄 Initializing Realtime Listener...');
            await this.connectionManager.initialize();
            this.provider = this.connectionManager.getWebSocketProvider();
            this.contract = this.connectionManager.getWebSocketContract();
            this.initializeWebSocketServer();
            this.setupBlockchainEvents();
            console.log('🚀 Realtime Listener initialized successfully');
        } catch (error) {
            console.error('❌ Realtime Listener initialization failed:', error);
            throw error;
        }
    }

    initializeWebSocketServer() {
        const server = http.createServer();
        this.wss = new WebSocket.Server({ server, path: '/ws' });

        this.wss.on('connection', (ws) => {
            console.log('🔗 New frontend client connected.');
            this.connectedClients.add(ws);
            ws.on('close', () => {
                console.log('🔌 Frontend client disconnected.');
                this.connectedClients.delete(ws);
            });
            ws.on('error', (error) => {
                console.error('❌ WebSocket client error:', error);
                this.connectedClients.delete(ws);
            });
        });

        server.listen(this.wsPort, '0.0.0.0', () => {
            console.log(`🚀 WebSocket server listening on port ${this.wsPort}`);
        });
    }

    broadcastToClients(message) {
        if (this.connectedClients.size === 0) return;
        const messageStr = JSON.stringify(message);
        this.connectedClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(messageStr);
            }
        });
    }

    setupBlockchainEvents() {
        this.contract.on('BetBull', (sender, epoch, amount, event) => {
            this.handleBetEvent(sender, epoch, amount, event, 'UP');
        });

        this.contract.on('BetBear', (sender, epoch, amount, event) => {
            this.handleBetEvent(sender, epoch, amount, event, 'DOWN');
        });

        this.contract.on('StartRound', (epoch) => {
            console.log(`🚀 New round started: ${epoch}`);
            this.broadcastToClients({ type: 'round_start', epoch: epoch.toString() });
        });

        this.contract.on('LockRound', (epoch) => {
            console.log(`🔒 Round locked: ${epoch}`);
            this.broadcastToClients({ type: 'round_lock', epoch: epoch.toString() });
        });
    }

    async handleBetEvent(sender, epoch, amount, event, direction) {
        const betKey = `${epoch.toString()}_${sender.toLowerCase()}`;
        if (this.processedBets.has(betKey)) {
            return; // Skip duplicate
        }
        this.processedBets.set(betKey, Date.now());

        const betData = {
            epoch: epoch.toString(),
            bet_ts: TimeService.getCurrentTaipeiTime(),
            wallet_address: sender.toLowerCase(),
            bet_direction: direction,
            amount: ethers.formatEther(amount)
        };

        const suspiciousCheck = this.suspiciousMonitor.checkSuspiciousWallet(sender, betData.amount, betData.epoch);
        this.broadcastToClients({ channel: 'new_bet_data', data: { ...betData, suspicious: suspiciousCheck } });

        try {
            await this.connectionManager.executeQuery(
                'INSERT INTO realbet (epoch, bet_ts, wallet_address, bet_direction, amount) VALUES ($1, $2, $3, $4, $5)',
                [betData.epoch, betData.bet_ts, betData.wallet_address, betData.bet_direction, betData.amount]
            );
        } catch (error) {
            console.error('❌ Failed to save real-time bet to database:', error);
        }
    }

    start() {
        this.initialize();
    }
}

module.exports = RealtimeListener;
