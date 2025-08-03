#!/usr/bin/env node

/**
 * DirectPushServer 啟動腳本
 * 用於啟動即時WebSocket推送服務
 */

const DirectPushServer = require('./direct-push-server');

// 環境配置
const config = {
    port: process.env.WS_PORT || 8080,
    rpcUrl: process.env.RPC_URL || 'wss://bsc-dataseed.binance.org/ws',
    contractAddress: process.env.CONTRACT_ADDRESS || 'YOUR_CONTRACT_ADDRESS_HERE',
    privateKey: process.env.PRIVATE_KEY // 可選，用於簽名交易
};

// 驗證必要配置
if (!config.contractAddress || config.contractAddress === 'YOUR_CONTRACT_ADDRESS_HERE') {
    console.error('❌ 錯誤：請設置 CONTRACT_ADDRESS 環境變量');
    console.error('💡 使用方法：');
    console.error('   export CONTRACT_ADDRESS=0x...');
    console.error('   node start-direct-push.js');
    process.exit(1);
}

console.log('🚀 啟動 DirectPushServer...');
console.log(`📡 WebSocket端口: ${config.port}`);
console.log(`🔗 RPC節點: ${config.rpcUrl}`);
console.log(`📋 合約地址: ${config.contractAddress}`);

const server = new DirectPushServer(config);

// 啟動服務
server.start()
    .then(() => {
        console.log('✅ DirectPushServer 啟動成功！');
        console.log(`🌐 WebSocket服務運行在: ws://localhost:${config.port}`);
        console.log('📊 正在監聽區塊鏈下注事件...');
    })
    .catch(error => {
        console.error('❌ 啟動失敗:', error.message);
        process.exit(1);
    });

// 優雅關閉
process.on('SIGTERM', () => {
    console.log('🛑 收到 SIGTERM，正在關閉服務...');
    server.stop();
});

process.on('SIGINT', () => {
    console.log('🛑 收到 SIGINT，正在關閉服務...');
    server.stop();
});

// 未捕獲異常處理
process.on('uncaughtException', (error) => {
    console.error('❌ 未捕獲異常:', error);
    server.stop();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ 未處理的Promise拒絕:', reason);
    server.stop();
    process.exit(1);
});