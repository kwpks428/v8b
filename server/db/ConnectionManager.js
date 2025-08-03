const { ethers } = require('ethers');
const { Pool } = require('pg');
const TimeService = require('../services/TimeService');
const dotenv = require('dotenv');

dotenv.config();

class ConnectionManager {
    constructor() {
        if (ConnectionManager.instance) {
            return ConnectionManager.instance;
        }
        ConnectionManager.instance = this;

        this.dbConfig = {
            connectionString: process.env.DATABASE_URL,
            max: 10,
            min: 2,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
            maxUses: 7500,
            allowExitOnIdle: false
        };

        this.rpcConfig = {
            httpUrl: process.env.RPC_HTTP_URL,
            wsUrl: process.env.RPC_WS_URL,
            timeout: 30000,
            retryAttempts: 3,
            retryDelay: 2000
        };

        this.contractConfig = {
            address: process.env.CONTRACT_ADDRESS,
            abiPath: './abi.json' // Adjusted path
        };

        this.connections = {
            dbPool: null,
            httpProvider: null,
            wsProvider: null,
            contract: null
        };

        this.status = {
            dbConnected: false,
            httpConnected: false,
            wsConnected: false,
            lastHealthCheck: null,
            reconnectAttempts: 0
        };

        this.healthCheckInterval = null;
        this.HEALTH_CHECK_INTERVAL = 60000;
        this.MAX_RECONNECT_ATTEMPTS = 5;
        this.RECONNECT_DELAY = 10000;

        console.log('🔧 ConnectionManager initialized');
    }

    async initialize() {
        try {
            console.log('🚀 [ConnectionManager] Initializing all connections...');
            await this.initializeDatabasePool();
            await this.initializeHttpProvider();
            await this.initializeWebSocketProvider();
            await this.initializeContract();
            this.startHealthCheck();
            console.log('✅ [ConnectionManager] All connections initialized');
            this.logConnectionStatus();
        } catch (error) {
            console.error('❌ [ConnectionManager] Initialization failed:', error.message);
            throw error;
        }
    }

    async initializeDatabasePool() {
        try {
            console.log('🗄️ [ConnectionManager] Initializing PostgreSQL pool...');
            this.connections.dbPool = new Pool(this.dbConfig);
            const client = await this.connections.dbPool.connect();
            const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
            client.release();
            this.status.dbConnected = true;
            console.log('✅ [ConnectionManager] PostgreSQL pool initialized successfully');
            console.log(`   📊 Database time: ${result.rows[0].current_time}`);
            console.log(`   📦 PostgreSQL version: ${result.rows[0].pg_version.split(' ')[0]}`);
            this.connections.dbPool.on('error', (err) => {
                console.error('❌ [ConnectionManager] PostgreSQL pool error:', err.message);
                this.status.dbConnected = false;
            });
        } catch (error) {
            console.error('❌ [ConnectionManager] PostgreSQL pool initialization failed:', error.message);
            this.status.dbConnected = false;
            throw error;
        }
    }

    async initializeHttpProvider() {
        try {
            console.log('🌐 [ConnectionManager] Initializing HTTP RPC Provider...');
            this.connections.httpProvider = new ethers.JsonRpcProvider(this.rpcConfig.httpUrl, 'binance', { timeout: this.rpcConfig.timeout, retryLimit: this.rpcConfig.retryAttempts });
            const network = await this.connections.httpProvider.getNetwork();
            const blockNumber = await this.connections.httpProvider.getBlockNumber();
            this.status.httpConnected = true;
            console.log('✅ [ConnectionManager] HTTP RPC Provider initialized successfully');
            console.log(`   🌐 Network: ${network.name} (ChainID: ${network.chainId})`);
            console.log(`   📦 Current block: ${blockNumber}`);
        } catch (error) {
            console.error('❌ [ConnectionManager] HTTP RPC Provider initialization failed:', error.message);
            this.status.httpConnected = false;
            throw error;
        }
    }

    async initializeWebSocketProvider() {
        try {
            console.log('🔌 [ConnectionManager] Initializing WebSocket Provider...');
            this.connections.wsProvider = new ethers.WebSocketProvider(this.rpcConfig.wsUrl);
            this.connections.wsProvider.websocket.on('open', () => {
                console.log('✅ [ConnectionManager] WebSocket connection established');
                this.status.wsConnected = true;
                this.status.reconnectAttempts = 0;
            });
            this.connections.wsProvider.websocket.on('close', () => {
                console.log('⚠️ [ConnectionManager] WebSocket connection closed');
                this.status.wsConnected = false;
                this.handleWebSocketReconnect();
            });
            this.connections.wsProvider.websocket.on('error', (error) => {
                console.error('❌ [ConnectionManager] WebSocket error:', error.message);
                this.status.wsConnected = false;
            });
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000);
                this.connections.wsProvider.websocket.on('open', () => { clearTimeout(timeout); resolve(); });
                this.connections.wsProvider.websocket.on('error', (error) => { clearTimeout(timeout); reject(error); });
            });
            const network = await this.connections.wsProvider.getNetwork();
            console.log('✅ [ConnectionManager] WebSocket Provider initialized successfully');
            console.log(`   🌐 Network: ${network.name} (ChainID: ${network.chainId})`);
        } catch (error) {
            console.error('❌ [ConnectionManager] WebSocket Provider initialization failed:', error.message);
            this.status.wsConnected = false;
            throw error;
        }
    }

    async initializeContract() {
        try {
            console.log('📋 [ConnectionManager] Initializing smart contract instance...');
            const fs = require('fs');
            const contractABI = JSON.parse(fs.readFileSync(this.contractConfig.abiPath, 'utf8'));
            this.connections.contract = new ethers.Contract(this.contractConfig.address, contractABI, this.connections.httpProvider);
            const currentEpoch = await this.connections.contract.currentEpoch();
            console.log('✅ [ConnectionManager] Smart contract instance initialized successfully');
            console.log(`   📋 Contract address: ${this.contractConfig.address}`);
            console.log(`   🎯 Current epoch: ${currentEpoch}`);
        } catch (error) {
            console.error('❌ [ConnectionManager] Smart contract instance initialization failed:', error.message);
            throw error;
        }
    }

    async handleWebSocketReconnect() {
        if (this.status.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            console.error('❌ [ConnectionManager] WebSocket reconnect attempts reached limit, stopping.');
            return;
        }
        this.status.reconnectAttempts++;
        console.log(`🔄 [ConnectionManager] Attempting WebSocket reconnect (${this.status.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(async () => {
            try {
                await this.initializeWebSocketProvider();
                console.log('✅ [ConnectionManager] WebSocket reconnected successfully');
            } catch (error) {
                console.error('❌ [ConnectionManager] WebSocket reconnect failed:', error.message);
            }
        }, this.RECONNECT_DELAY * this.status.reconnectAttempts);
    }

    async getDatabaseConnection() {
        if (!this.connections.dbPool || !this.status.dbConnected) throw new Error('Database pool not initialized or connection failed');
        try {
            return await this.connections.dbPool.connect();
        } catch (error) {
            console.error('❌ [ConnectionManager] Failed to get database connection:', error.message);
            this.status.dbConnected = false;
            throw error;
        }
    }

    getHttpProvider() {
        if (!this.connections.httpProvider || !this.status.httpConnected) throw new Error('HTTP RPC Provider not initialized or connection failed');
        return this.connections.httpProvider;
    }

    getWebSocketProvider() {
        if (!this.connections.wsProvider) throw new Error('WebSocket Provider not initialized');
        return this.connections.wsProvider;
    }

    getContract() {
        if (!this.connections.contract) throw new Error('Smart contract instance not initialized');
        return this.connections.contract;
    }

    getWebSocketContract() {
        if (!this.connections.wsProvider || !this.connections.contract) throw new Error('WebSocket Provider or contract instance not initialized');
        const fs = require('fs');
        const contractABI = JSON.parse(fs.readFileSync(this.contractConfig.abiPath, 'utf8'));
        return new ethers.Contract(this.contractConfig.address, contractABI, this.connections.wsProvider);
    }

    async executeQuery(sql, params = []) {
        const client = await this.getDatabaseConnection();
        try {
            return await client.query(sql, params);
        } finally {
            client.release();
        }
    }

    async executeTransaction(queries) {
        const client = await this.getDatabaseConnection();
        try {
            await client.query('BEGIN');
            const results = [];
            for (const { sql, params } of queries) {
                results.push(await client.query(sql, params));
            }
            await client.query('COMMIT');
            return results;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async performHealthCheck() {
        const results = { database: false, httpRpc: false, webSocket: false, timestamp: new Date().toISOString() };
        try {
            await this.executeQuery('SELECT 1');
            results.database = true;
            this.status.dbConnected = true;
        } catch (error) {
            console.error('❌ [ConnectionManager] Database health check failed:', error.message);
            this.status.dbConnected = false;
        }
        try {
            await this.connections.httpProvider.getBlockNumber();
            results.httpRpc = true;
            this.status.httpConnected = true;
        } catch (error) {
            console.error('❌ [ConnectionManager] HTTP RPC health check failed:', error.message);
            this.status.httpConnected = false;
        }
        results.webSocket = this.status.wsConnected && this.connections.wsProvider?.websocket?.readyState === 1;
        this.status.lastHealthCheck = results.timestamp;
        return results;
    }

    startHealthCheck() {
        console.log('🩺 [ConnectionManager] Starting periodic health checks');
        this.healthCheckInterval = setInterval(async () => {
            const health = await this.performHealthCheck();
            const allHealthy = health.database && health.httpRpc && health.webSocket;
            if (!allHealthy) {
                console.warn('⚠️ [ConnectionManager] Health check found issues:', { database: health.database ? '✅' : '❌', httpRpc: health.httpRpc ? '✅' : '❌', webSocket: health.webSocket ? '✅' : '❌' });
            }
        }, this.HEALTH_CHECK_INTERVAL);
    }

    logConnectionStatus() {
        console.log('📊 [ConnectionManager] Connection status overview:');
        console.log(`   🗄️ Database: ${this.status.dbConnected ? '✅ Connected' : '❌ Disconnected'}`);
        console.log(`   🌐 HTTP RPC: ${this.status.httpConnected ? '✅ Connected' : '❌ Disconnected'}`);
        console.log(`   🔌 WebSocket: ${this.status.wsConnected ? '✅ Connected' : '❌ Disconnected'}`);
        console.log(`   📋 Smart Contract: ${this.connections.contract ? '✅ Initialized' : '❌ Not Initialized'}`);
    }

    async close() {
        console.log('🛑 [ConnectionManager] Closing all connections...');
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        if (this.connections.wsProvider) {
            try {
                this.connections.wsProvider.websocket.close();
                console.log('✅ [ConnectionManager] WebSocket connection closed');
            } catch (error) {
                console.error('❌ [ConnectionManager] Failed to close WebSocket:', error.message);
            }
        }
        if (this.connections.dbPool) {
            try {
                await this.connections.dbPool.end();
                console.log('✅ [ConnectionManager] Database pool closed');
            } catch (error) {
                console.error('❌ [ConnectionManager] Failed to close database pool:', error.message);
            }
        }
        this.status = { dbConnected: false, httpConnected: false, wsConnected: false, lastHealthCheck: null, reconnectAttempts: 0 };
        this.connections = { dbPool: null, httpProvider: null, wsProvider: null, contract: null };
        console.log('✅ [ConnectionManager] All connections closed');
    }

    getConnectionStats() {
        return {
            status: { ...this.status },
            dbPool: this.connections.dbPool ? { totalCount: this.connections.dbPool.totalCount, idleCount: this.connections.dbPool.idleCount, waitingCount: this.connections.dbPool.waitingCount } : null,
            healthCheck: { interval: this.HEALTH_CHECK_INTERVAL, lastCheck: this.status.lastHealthCheck }
        };
    }
}

module.exports = new ConnectionManager();
