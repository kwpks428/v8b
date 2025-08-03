// 純粹的WebSocket數據接收器
class WebSocketReceiver {
    constructor() {
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectTimeout = null;
        this.onDataReceived = null; // 回調函數
        
        this.connectWebSocket();
    }
    
    connectWebSocket() {
        try {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = protocol + '//' + window.location.host;
            
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                console.log('✅ WebSocket 連接成功');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                if (this.onDataReceived) {
                    this.onDataReceived({ type: 'connection', connected: true });
                }
            };
            
            this.ws.onmessage = (event) => {
                // 處理心跳ping框
                if (event.data instanceof ArrayBuffer || typeof event.data !== 'string') {
                    return; // 心跳框，不處理
                }
                
                try {
                    const data = JSON.parse(event.data);
                    console.log('📩 收到WebSocket原始數據:', data);
                    if (this.onDataReceived) {
                        this.onDataReceived(data);
                    }
                } catch (error) {
                    console.error('❌ 消息解析失敗:', error);
                }
            };
            
            this.ws.onclose = (event) => {
                console.log('❌ WebSocket 連接關閉', event.code, event.reason);
                this.isConnected = false;
                if (this.onDataReceived) {
                    this.onDataReceived({ type: 'connection', connected: false });
                }
                
                if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    console.log(`⚙️ 嘗試重連 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
                    this.reconnectTimeout = setTimeout(() => this.connectWebSocket(), 3000);
                }
            };
            
            this.ws.onerror = (error) => {
                console.error('❌ WebSocket 錯誤:', error);
                this.isConnected = false;
                if (this.onDataReceived) {
                    this.onDataReceived({ type: 'connection', connected: false });
                }
            };
            
        } catch (error) {
            console.error('❌ WebSocket 連接失敗:', error);
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                this.reconnectTimeout = setTimeout(() => this.connectWebSocket(), 3000);
            }
        }
    }
    
    setDataHandler(handler) {
        this.onDataReceived = handler;
    }
    
    // 手動發送心跳
    sendHeartbeat() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
            console.log('💗 發送心跳');
        }
    }
}

// 數據處理器
class DataProcessor {
    constructor() {
        this.betsData = new Map();
        this.currentRound = null;
        this.viewingRound = null;
        this.currentLockTimestamp = null;
        this.autoFollow = true;
    }

    handleConnection(data) {
        return { type: 'connection_status', connected: data.connected };
    }

    handleRoundUpdate(data) {
        console.log('🔄 處理局次更新事件');
        this.currentRound = String(data.epoch);
        this.currentLockTimestamp = data.lockTimestamp;

        if (this.autoFollow) {
            this.viewingRound = String(data.epoch);
            return {
                type: 'round_changed',
                epoch: this.viewingRound,
                lockTimestamp: this.currentLockTimestamp,
                isLatest: true
            };
        } else {
            return {
                type: 'round_info_updated',
                currentRound: this.currentRound,
                viewingRound: this.viewingRound,
                lockTimestamp: this.currentLockTimestamp
            };
        }
    }

    handleRoundLock(data) {
        console.log('🔒 處理局次鎖倉事件');
        return { type: 'round_locked', epoch: data.epoch };
    }

    handleNewBet(data) {
        console.log('📨 處理新下注數據');
        if (String(data.epoch) === String(this.viewingRound)) {
            if (!this.betsData.has(data.epoch)) {
                this.betsData.set(data.epoch, []);
            }
            this.betsData.get(data.epoch).push(data);

            return {
                type: 'new_bet_processed',
                bet: data,
                forCurrentRound: true
            };
        } else {
            return {
                type: 'new_bet_processed',
                bet: data,
                forCurrentRound: false
            };
        }
    }

    processData(data) {
        console.log('🔄 處理數據:', data.type);
        
        switch (data.type) {
            case 'connection':
            case 'connection_status':
                return this.handleConnection(data);
            case 'round_update':
            case 'round_start':
                return this.handleRoundUpdate(data);
            case 'round_lock':
                return this.handleRoundLock(data);
            case 'new_bet':
                return this.handleNewBet(data);
            default:
                console.log('❓ 未知的數據類型:', data.type);
                return null;
        }
    }
    
    getCurrentRoundBets() {
        return this.betsData.get(this.viewingRound) || [];
    }
    
    // 設置查看局次
    setViewingRound(epoch, autoFollow = false) {
        this.viewingRound = String(epoch);
        this.autoFollow = autoFollow;
        console.log(`📍 設置查看局次: ${epoch}, 自動跟隨: ${autoFollow}`);
    }
    
    // 獲取相鄰局次
    getPreviousRound() {
        const current = parseInt(this.viewingRound);
        return isNaN(current) ? null : String(current - 1);
    }
    
    getNextRound() {
        const current = parseInt(this.viewingRound);
        const next = isNaN(current) ? null : String(current + 1);
        // 不能超過當前最新局次
        if (next && this.currentRound && parseInt(next) > parseInt(this.currentRound)) {
            return null;
        }
        return next;
    }
    
    // 檢查是否在查看最新局次
    isViewingLatest() {
        return this.viewingRound === this.currentRound;
    }
}

// 主控制器
class BettingMonitor {
    constructor() {
        this.wsReceiver = new WebSocketReceiver();
        this.dataProcessor = new DataProcessor();
        this.countdownInterval = null;
        this.connectionCheckInterval = null;
        this.lastDataTime = Date.now();
        
        this.initializeView();
        this.setupDataFlow();
        this.startConnectionMonitor();
    }
    
    setupDataFlow() {
        // 設置數據流：WebSocket -> DataProcessor -> UI更新
        this.wsReceiver.setDataHandler((rawData) => {
            const processedData = this.dataProcessor.processData(rawData);
            if (processedData) {
                this.handleProcessedData(processedData);
            }
        });
    }
    
    handleProcessedData(data) {
        // 更新最後數據時間
        this.lastDataTime = Date.now();
        
        switch (data.type) {
            case 'connection_status':
                this.updateConnectionStatus(data.connected);
                break;
                
            case 'round_changed':
                this.handleRoundChange(data);
                break;
                
            case 'round_info_updated':
                this.handleRoundInfoUpdate(data);
                break;
                
            case 'round_locked':
                this.handleRoundLock(data);
                break;
                
            case 'new_bet_processed':
                if (data.forCurrentRound) {
                    this.handleNewBetForCurrentRound(data.bet);
                }
                break;
        }
    }

    initializeView() {
        setTimeout(() => {
            if (window.UIHandler) {
                window.UIHandler.showLoading();
            }
        }, 100);
        this.updateConnectionStatus(false);
        this.setupNavigationButtons();
    }

    updateConnectionStatus(connected) {
        const statusElement = document.getElementById('connectionStatus');
        if (statusElement) {
            statusElement.textContent = connected ? '已連接' : '未連接';
            statusElement.className = 'connection-status ' + (connected ? 'connected' : 'disconnected');
        }
        
        // 連接成功時，載入當前局次數據
        if (connected && this.dataProcessor.autoFollow) {
            this.loadCurrentRoundData();
        }
    }
    
    // 載入當前局次數據
    async loadCurrentRoundData() {
        try {
            console.log('🎯 連接成功，載入當前局次數據');
            const response = await fetch('/api/realtime-status');
            const data = await response.json();
            
            if (data.success && data.currentRound) {
                console.log(`📡 當前局次: ${data.currentRound}`);
                this.dataProcessor.currentRound = String(data.currentRound);
                this.dataProcessor.viewingRound = String(data.currentRound);
                this.dataProcessor.currentLockTimestamp = data.currentLockTimestamp;
                
                // 載入當前局次的下注數據
                this.loadRoundData(String(data.currentRound));
                
                // 更新界面顯示
                this.updateRoundDisplay(data.currentRound, true);
                
                // 開始鎖倉倒數
                if (data.currentLockTimestamp) {
                    this.startLockCountdown(data.currentLockTimestamp);
                }
            }
        } catch (error) {
            console.error('❌ 載入當前局次數據失敗:', error);
        }
    }

    handleRoundChange(data) {
        console.log('🔄 局次變更 (自動跳轉):', data);
        
        this.updateRoundDisplay(data.epoch, true);
        
        // 開始鎖倉倒數
        if (data.lockTimestamp) {
            console.log(`   開始倒數計時: ${data.lockTimestamp}`);
            this.startLockCountdown(data.lockTimestamp);
        }
        
        // 載入新局次數據
        console.log(`   載入局次 ${data.epoch} 的數據`);
        this.loadRoundData(String(data.epoch));
    }
    
    handleRoundInfoUpdate(data) {
        console.log('📊 局次信息更新 (不自動跳轉):', data);
        // 僅更新界面顯示，不載入數據
        this.updateNavigationState();
    }

    handleRoundLock(data) {
        console.log('🔒 局次鎖倉:', data.epoch);
        this.stopLockCountdown();
        
        const lockCountdownElement = document.getElementById('lockCountdown');
        if (lockCountdownElement) {
            lockCountdownElement.textContent = '已鎖倉';
        }
    }

    handleNewBetForCurrentRound(bet) {
        console.log('✅ 處理當前局次新下注:', bet);
        this.addBetToDisplay(bet);
        this.updateStatsFromNewBet(bet);
    }

    // 🧠 智能載入局次數據 - 使用新的無縫接軋API
    async loadRoundData(epoch) {
        try {
            const epochStr = String(epoch);
            console.log(`🔍 開始智能載入局次 ${epochStr} 的數據`);
            
            const response = await fetch('/api/round-data/' + epochStr);
            const data = await response.json();
            
            console.log(`📥 智能 API 響應:`, data);
            
            if (data.success) {
                const { bets, source, message } = data;
                console.log(`   ✅ ${message} - 數據來源: ${source}`);
                
                // 更新界面顯示數據來源
                this.updateDataSourceIndicator(source, message);
                
                // 顯示下注數據
                this.displayBets(bets, epochStr);
                this.updateStats(bets);
                
                // 🎯 錢包48局歷史會在顯示下注數據時自動載入
                
            } else {
                console.log('   ❌ API請求失敗:', data.error);
                this.showNoDataMessage(data.error);
            }
        } catch (error) {
            console.error('❌ 智能載入局次數據失敗:', error);
            this.showNoDataMessage('網路請求失敗');
        }
    }

    // 🎨 顯示下注數據 - 包含錢包48局歷史和備註
    displayBets(bets, epoch) {
        if (window.UIHandler) {
            window.UIHandler.displayBetsWithHistory(bets, epoch, (wallet) => {
                return this.loadWalletHistory(wallet, epoch);
            });
        }
    }

    addBetToDisplay(bet) {
        if (window.UIHandler) {
            window.UIHandler.addBetToDisplay(bet, this.dataProcessor.viewingRound);
        }
    }

    updateStats(bets) {
        if (!bets) return;
        const upBets = bets.filter(bet => bet.direction === 'UP');
        const downBets = bets.filter(bet => bet.direction === 'DOWN');
        const upAmount = upBets.reduce((sum, bet) => sum + parseFloat(bet.amount), 0);
        const downAmount = downBets.reduce((sum, bet) => sum + parseFloat(bet.amount), 0);
        const totalAmount = upAmount + downAmount;
        
        // 計算賠率 (總金額扣3%手續費後按佔比分配)
        const treasuryFeeRate = 0.03;
        const totalAfterFee = totalAmount * (1 - treasuryFeeRate);
        
        let upPayout = 0;
        let downPayout = 0;
        
        if (upAmount > 0) {
            upPayout = totalAfterFee / upAmount;
        }
        if (downAmount > 0) {
            downPayout = totalAfterFee / downAmount;
        }
        
        // 更新顯示
        const totalUpElement = document.getElementById('totalUp');
        const totalDownElement = document.getElementById('totalDown');
        const totalBetsElement = document.getElementById('totalBets');
        
        if (totalUpElement) {
            totalUpElement.textContent = `${upAmount.toFixed(4)} (${upPayout.toFixed(2)}x)`;
        }
        if (totalDownElement) {
            totalDownElement.textContent = `${downAmount.toFixed(4)} (${downPayout.toFixed(2)}x)`;
        }
        if (totalBetsElement) {
            totalBetsElement.textContent = `${totalAmount.toFixed(4)} BNB (${bets.length}筆)`;
        }
    }

    updateStatsFromNewBet(bet) {
        // 直接重新載入數據，重新計算
        this.loadRoundData(this.dataProcessor.viewingRound);
    }

    startLockCountdown(lockTimestamp) {
        this.stopLockCountdown(); // 清除既有倒數
        
        const lockCountdownElement = document.getElementById('lockCountdown');
        if (!lockCountdownElement) return;
        
        const lockTime = lockTimestamp * 1000; // 轉換為毫秒
        
        this.countdownInterval = setInterval(() => {
            const now = Date.now();
            const timeLeft = lockTime - now;
            
            if (timeLeft <= 0) {
                lockCountdownElement.textContent = '即將鎖倉';
                this.stopLockCountdown();
                return;
            }
            
            const minutes = Math.floor(timeLeft / 60000);
            const seconds = Math.floor((timeLeft % 60000) / 1000);
            lockCountdownElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }, 1000);
    }

    stopLockCountdown() {
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }
    }
    
    // 連接狀態監控
    startConnectionMonitor() {
        this.connectionCheckInterval = setInterval(() => {
            const timeSinceLastData = Date.now() - this.lastDataTime;
            
            // 如果超過60秒沒有收到任何數據，發送心跳
            if (timeSinceLastData > 60000) {
                console.log('⚠️ 長時間無數據，發送心跳');
                this.wsReceiver.sendHeartbeat();
            }
            
            // 如果超過120秒沒有數據，重新連接
            if (timeSinceLastData > 120000) {
                console.log('❌ 長時間無數據，強制重連');
                this.wsReceiver.connectWebSocket();
                this.lastDataTime = Date.now();
            }
        }, 30000); // 每30秒檢查一次
    }
    
    // 📊 更新數據來源指示器
    updateDataSourceIndicator(source, message) {
        const currentRoundElement = document.getElementById('currentRound');
        if (!currentRoundElement) return;
        
        // 獲取當前局次號
        const epochMatch = currentRoundElement.textContent.match(/\d+/);
        const epoch = epochMatch ? epochMatch[0] : '--';
        
        // 根據數據來源更新顯示
        let displayText = epoch;
        let sourceIcon = '';
        let label = '';
        
        switch(source) {
            case 'realtime':
                sourceIcon = '📡';
                label = '即時';
                break;
            case 'history':
                sourceIcon = '📚';
                label = '歷史';
                break;
            case 'none':
                sourceIcon = '❌';
                label = '無數據';
                break;
            default:
                sourceIcon = '❓';
                label = '未知';
        }
        
        displayText += ` ${sourceIcon}${label}`;
        currentRoundElement.textContent = displayText;
        console.log(`📊 數據來源指示器更新: ${displayText}`);
    }
    
    // 🚨 顯示無數據消息
    showNoDataMessage(message) {
        if (window.UIHandler) {
            window.UIHandler.showNoData(message);
        }
    }
    
    // 🎯 載入指定錢包的48局歷史和備註
    async loadWalletHistory(wallet, currentEpoch) {
        try {
            const startEpoch = parseInt(currentEpoch) - 2; // 從當前局-2開始
            console.log(`🎯 載入錢包 ${wallet} 的48局歷史，起始局次: ${startEpoch}`);
            
            // 並行載入錢包歷史和備註
            const [historyResponse, noteResponse] = await Promise.all([
                fetch(`/api/wallet-history/${encodeURIComponent(wallet)}/${startEpoch}`),
                fetch(`/api/wallet-note/${encodeURIComponent(wallet)}`)
            ]);
            
            const historyData = await historyResponse.json();
            const noteData = await noteResponse.json();
            
            const result = {
                history: historyData.success ? historyData.results : [],
                note: noteData.success ? noteData.note : '',
                wallet: wallet,
                message: historyData.success ? historyData.message : '歷史數據載入失敗'
            };
            
            console.log(`✅ 錢包 ${wallet} 歷史載入完成:`, result.message);
            return result;
            
        } catch (error) {
            console.error(`❌ 載入錢包 ${wallet} 歷史失敗:`, error);
            return {
                history: [],
                note: '',
                wallet: wallet,
                message: '載入失敗'
            };
        }
    }
    
    // 設置導航按鈕
    setupNavigationButtons() {
        const prevBtn = document.getElementById('prevRoundBtn');
        const nextBtn = document.getElementById('nextRoundBtn');
        const refreshBtn = document.getElementById('refreshBtn');
        const goBtn = document.getElementById('goButton');
        const roundInput = document.getElementById('roundInput');
        
        if (prevBtn) {
            prevBtn.addEventListener('click', () => this.navigateToPrevious());
        }
        
        if (nextBtn) {
            nextBtn.addEventListener('click', () => this.navigateToNext());
        }
        
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.refreshCurrentRound());
        }
        
        if (goBtn && roundInput) {
            const handleGo = () => {
                const targetRound = roundInput.value.trim();
                if (targetRound) {
                    this.navigateToRound(targetRound);
                    roundInput.value = '';
                }
            };
            
            goBtn.addEventListener('click', handleGo);
            roundInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    handleGo();
                }
            });
        }
    }
    
    // 導航到上一局
    navigateToPrevious() {
        const prevRound = this.dataProcessor.getPreviousRound();
        if (prevRound) {
            console.log(`🔙 導航到上一局: ${prevRound}`);
            this.navigateToRound(prevRound);
        }
    }
    
    // 導航到下一局
    navigateToNext() {
        const nextRound = this.dataProcessor.getNextRound();
        if (nextRound) {
            console.log(`🔜 導航到下一局: ${nextRound}`);
            this.navigateToRound(nextRound);
        }
    }
    
    // 導航到指定局次
    navigateToRound(targetRound) {
        const epochStr = String(targetRound);
        
        // 檢查是否是最新局次
        const isLatest = epochStr === this.dataProcessor.currentRound;
        
        // 設置查看局次
        this.dataProcessor.setViewingRound(epochStr, isLatest);
        
        // 更新顯示
        this.updateRoundDisplay(epochStr, isLatest);
        
        // 載入數據
        this.loadRoundData(epochStr);
    }
    
    // 刷新當前局次
    refreshCurrentRound() {
        if (this.dataProcessor.viewingRound) {
            console.log(`🔄 刷新局次: ${this.dataProcessor.viewingRound}`);
            this.loadRoundData(this.dataProcessor.viewingRound);
        }
    }
    
    // 更新局次顯示
    updateRoundDisplay(epoch, isLatest) {
        const currentRoundElement = document.getElementById('currentRound');
        if (currentRoundElement) {
            const baseText = epoch + (isLatest ? ' (最新)' : '');
            currentRoundElement.textContent = baseText;
            // 數據來源指示器會在loadRoundData中更新
        }
        
        this.updateNavigationState();
    }
    
    // 更新導航按鈕狀態
    updateNavigationState() {
        const prevBtn = document.getElementById('prevRoundBtn');
        const nextBtn = document.getElementById('nextRoundBtn');
        
        if (prevBtn) {
            prevBtn.disabled = !this.dataProcessor.getPreviousRound();
        }
        
        if (nextBtn) {
            nextBtn.disabled = !this.dataProcessor.getNextRound();
        }
    }
}

// 初始化監控器
document.addEventListener('DOMContentLoaded', () => {
    window.bettingMonitor = new BettingMonitor();
    
    // 全域快捷鍵
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName.toLowerCase() === 'input') return;
        
        switch(e.key) {
            case 'ArrowLeft':
                e.preventDefault();
                window.bettingMonitor.navigateToPrevious();
                break;
            case 'ArrowRight':
                e.preventDefault();
                window.bettingMonitor.navigateToNext();
                break;
            case 'r':
            case 'R':
                e.preventDefault();
                window.bettingMonitor.refreshCurrentRound();
                break;
        }
    });
});