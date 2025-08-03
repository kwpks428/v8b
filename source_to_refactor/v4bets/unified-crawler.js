const { ethers } = require('ethers');
const DatabaseV4 = require('./database.js');
const TimeUtils = require('./time-utils');

// 合約配置
const CONTRACT_ADDRESS = '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA';
const CONTRACT_ABI = require('./abi.json');
const RPC_URL = 'https://lb.drpc.org/bsc/Ahc3I-33qkfGuwXSahR3XfPDRmd6WZsR8JbErqRhf0fE';

class UnifiedDataCrawler {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(RPC_URL);
    this.contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, this.provider);
    this.db = new DatabaseV4();
    this.treasuryFeeRate = 0.03;
    
    // 請求限制
    this.maxRequestsPerSecond = 100;
    this.requestDelay = Math.ceil(1000 / this.maxRequestsPerSecond);
    this.lastRequestTime = 0;
    
    // 抓取狀態
    this.isProcessingHistory = false;
    this.historyInterval = null; // 歷史回補定時器
    this.shouldStopHistory = false; // 優雅停止標記
    
    // 失敗重試記錄
    this.failedAttempts = new Map(); // epoch -> attempt count
  }

  async initialize() {
    try {
      await this.db.initialize();
      console.log('✅ 一體化數據抓取器初始化成功');
    } catch (error) {
      console.error('❌ 初始化失敗:', error.message);
      throw error;
    }
  }


  // 請求限制控制
  async rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.requestDelay) {
      const waitTime = this.requestDelay - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  // 帶重試的網路請求
  async retryRequest(operation, operationName, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.rateLimit();
        const result = await operation();
        return result;
      } catch (error) {
        if (attempt === retries) {
          console.error(`❌ ${operationName} 失敗 (${attempt}/${retries}) - ${error.message}`);
          throw error;
        }
        
        const delay = 2000 * attempt;
        console.log(`⚠️ ${operationName} 重試 ${attempt}/${retries}，等待 ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // 獲取當前最新回合
  async getCurrentEpoch() {
    try {
      const epoch = await this.retryRequest(
        () => this.contract.currentEpoch(),
        '獲取當前回合'
      );
      return Number(epoch);
    } catch (error) {
      console.error('獲取當前回合失敗:', error.message);
      return 0;
    }
  }

  // 格式化時間戳為台北時間
  formatTimestamp(timestamp) {
    return TimeUtils.formatUnixTimestamp(timestamp);
  }

  // 計算賠率（扣3%手續費）
  calculatePayouts(totalAmount, bullAmount, bearAmount) {
    const totalAfterFee = totalAmount * (1 - this.treasuryFeeRate);
    
    let bullPayout = 0;
    let bearPayout = 0;
    
    if (bullAmount > 0) {
      bullPayout = totalAfterFee / bullAmount;
    }
    
    if (bearAmount > 0) {
      bearPayout = totalAfterFee / bearAmount;
    }
    
    return {
      bullPayout: bullPayout.toString(),
      bearPayout: bearPayout.toString()
    };
  }

  // 檢查回合是否已存在
  async hasRoundData(epoch) {
    try {
      return await this.db.hasRound(epoch);
    } catch (error) {
      console.error(`檢查回合 ${epoch} 失敗:`, error.message);
      return false;
    }
  }

  // 獲取回合開始時間（不需要等回合結束）
  async getRoundStartTime(epoch) {
    try {
      const round = await this.retryRequest(
        () => this.contract.rounds(epoch),
        `獲取回合 ${epoch} 開始時間`
      );
      
      if (round.startTimestamp == 0) {
        return null; // 回合尚未開始
      }
      
      return {
        epoch: Number(round.epoch),
        start_ts: this.formatTimestamp(Number(round.startTimestamp))
      };
      
    } catch (error) {
      console.error(`獲取回合 ${epoch} 開始時間失敗:`, error.message);
      return null;
    }
  }

  // 獲取回合基本數據
  async getRoundData(epoch) {
    try {
      const round = await this.retryRequest(
        () => this.contract.rounds(epoch),
        `獲取回合 ${epoch} 基本數據`
      );
      
      if (!round.oracleCalled || round.closeTimestamp == 0) {
        return null; // 回合尚未結束
      }

      const totalAmount = parseFloat(ethers.formatEther(round.totalAmount));
      const bullAmount = parseFloat(ethers.formatEther(round.bullAmount));
      const bearAmount = parseFloat(ethers.formatEther(round.bearAmount));
      
      const lockPrice = parseFloat(ethers.formatUnits(round.lockPrice, 8));
      const closePrice = parseFloat(ethers.formatUnits(round.closePrice, 8));
      
      const result = closePrice > lockPrice ? 'UP' : 'DOWN';
      const payouts = this.calculatePayouts(totalAmount, bullAmount, bearAmount);
      
      return {
        epoch: Number(round.epoch),
        start_ts: this.formatTimestamp(Number(round.startTimestamp)),
        lock_ts: this.formatTimestamp(Number(round.lockTimestamp)),
        close_ts: this.formatTimestamp(Number(round.closeTimestamp)),
        lock_price: lockPrice.toString(),
        close_price: closePrice.toString(),
        result: result,
        total_amount: totalAmount.toString(),
        up_amount: bullAmount.toString(),
        down_amount: bearAmount.toString(),
        up_payout: payouts.bullPayout,
        down_payout: payouts.bearPayout
      };
      
    } catch (error) {
      console.error(`獲取回合 ${epoch} 數據失敗:`, error.message);
      return null;
    }
  }

  // 根據時間戳查找最接近的區塊
  async findBlockByTimestamp(targetTimestamp) {
    try {
      const currentBlock = await this.retryRequest(
        () => this.provider.getBlockNumber(),
        '獲取當前區塊號'
      );
      const currentBlockData = await this.retryRequest(
        () => this.provider.getBlock(currentBlock),
        `獲取當前區塊數據 ${currentBlock}`
      );
      const currentTimestamp = currentBlockData.timestamp;
      
      if (targetTimestamp >= currentTimestamp) {
        return currentBlock;
      }
      
      // 二分查找算法
      let low = 1;
      let high = currentBlock;
      let closestBlock = high;
      let closestDiff = Math.abs(currentTimestamp - targetTimestamp);
      
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        
        const blockData = await this.retryRequest(
          () => this.provider.getBlock(mid),
          `獲取區塊 ${mid} 數據`
        );
        
        if (!blockData) {
          high = mid - 1;
          continue;
        }
        
        const blockTimestamp = blockData.timestamp;
        const diff = Math.abs(blockTimestamp - targetTimestamp);
        
        if (diff < closestDiff) {
          closestDiff = diff;
          closestBlock = mid;
        }
        
        if (blockTimestamp < targetTimestamp) {
          low = mid + 1;
        } else if (blockTimestamp > targetTimestamp) {
          high = mid - 1;
        } else {
          return mid; // 完全匹配
        }
      }
      
      return closestBlock;
      
    } catch (error) {
      console.error(`查找時間戳 ${targetTimestamp} 對應區塊失敗:`, error.message);
      return null;
    }
  }

  // 獲取指定區塊範圍內的事件
  async getEventsInRange(fromBlock, toBlock) {
    try {
      const betBullFilter = this.contract.filters.BetBull();
      const betBearFilter = this.contract.filters.BetBear();
      const claimFilter = this.contract.filters.Claim();
      
      const [betBullEvents, betBearEvents, claimEvents] = await Promise.all([
        this.retryRequest(
          () => this.contract.queryFilter(betBullFilter, fromBlock, toBlock),
          `獲取 BetBull 事件 (${fromBlock}-${toBlock})`
        ),
        this.retryRequest(
          () => this.contract.queryFilter(betBearFilter, fromBlock, toBlock),
          `獲取 BetBear 事件 (${fromBlock}-${toBlock})`
        ),
        this.retryRequest(
          () => this.contract.queryFilter(claimFilter, fromBlock, toBlock),
          `獲取 Claim 事件 (${fromBlock}-${toBlock})`
        )
      ]);
      
      return {
        betBullEvents,
        betBearEvents,
        claimEvents
      };
      
    } catch (error) {
      console.error(`獲取區塊範圍 ${fromBlock}-${toBlock} 事件失敗:`, error.message);
      return {
        betBullEvents: [],
        betBearEvents: [],
        claimEvents: []
      };
    }
  }

  // 創建驗證失敗結果
  createValidationError(reason) {
    return { valid: false, reason };
  }

  // 驗證數據完整性
  validateDataIntegrity(roundData, betData, claimData) {
    // 檢查 rounds 數據
    if (!roundData || !roundData.epoch) {
      return this.createValidationError('rounds 數據缺失或不完整');
    }
    
    // 檢查必要欄位
    const requiredFields = ['start_ts', 'lock_ts', 'close_ts', 'lock_price', 'close_price', 'result', 'total_amount'];
    for (const field of requiredFields) {
      if (!roundData[field] && roundData[field] !== 0) {
        return this.createValidationError(`rounds 表缺少 ${field} 欄位`);
      }
    }
    
    // 檢查 hisbets 數據
    if (!betData || betData.length === 0) {
      return this.createValidationError('hisbets 數據缺失，至少需要一筆下注數據');
    }
    
    // 檢查是否同時有UP和DOWN數據
    const hasUpBets = betData.some(bet => bet.bet_direction === 'UP');
    const hasDownBets = betData.some(bet => bet.bet_direction === 'DOWN');
    
    if (!hasUpBets || !hasDownBets) {
      return this.createValidationError('hisbets 數據不完整，需要同時包含UP和DOWN數據');
    }
    
    // 檢查 claims 數據
    if (!claimData || claimData.length === 0) {
      return this.createValidationError('claims 數據缺失，至少需要一筆領獎數據');
    }
    
    return { valid: true };
  }

  // 處理單個回合數據
  async processEpochData(epoch) {
    try {
      console.log(`🔄 開始處理回合 ${epoch}`);
      
      // 檢查是否應該跳過此回合（失敗次數過多）
      if (await this.db.shouldSkipEpoch(epoch)) {
        console.log(`⏭️ 跳過回合 ${epoch}（失敗次數過多）`);
        return false;
      }
      
      // 獲取回合基本數據
      const roundData = await this.getRoundData(epoch);
      if (!roundData) {
        console.log(`⏭️ 回合 ${epoch} 尚未結束或數據無效`);
        return false;
      }
      
      // 獲取下一局的開始時間（只需要開始時間，不需要等結束）
      const nextRoundData = await this.getRoundStartTime(epoch + 1);
      if (!nextRoundData) {
        console.log(`⏭️ 無法獲取下一回合 ${epoch + 1} 開始時間，跳過`);
        return false;
      }
      
      // ⚠️ 【嚴禁修改】計算時間範圍對應的區塊 - 使用當局開始時間到下一局開始時間
      // 🚨 警告：任何人擅自修改此邏輯將承擔嚴重後果！
      const startTimestamp = Math.floor(new Date(roundData.start_ts).getTime() / 1000);
      const endTimestamp = Math.floor(new Date(nextRoundData.start_ts).getTime() / 1000);
      
      const startBlock = await this.findBlockByTimestamp(startTimestamp);
      const endBlock = await this.findBlockByTimestamp(endTimestamp);
      
      if (!startBlock || !endBlock) {
        throw new Error('無法確定區塊範圍');
      }
      
      console.log(`📊 回合 ${epoch} 區塊範圍: ${startBlock} - ${endBlock}`);
      
      // 獲取所有相關事件
      const events = await this.getEventsInRange(startBlock, endBlock);
      
      // 處理下注事件 - 保存區塊範圍內所有事件，不管是哪一局的
      const betData = [];
      
      // 統一處理所有下注事件，傳入回合結果用於計算WIN/LOSS
      await this.processBetEvents(events.betBullEvents, 'UP', betData, roundData.result);
      await this.processBetEvents(events.betBearEvents, 'DOWN', betData, roundData.result);
      
      // 處理領獎事件 - 保存區塊範圍內所有事件，不管是哪一局的
      const claimData = [];
      for (const event of events.claimEvents) {
        claimData.push({
          epoch: Number(event.args.epoch),
          claim_ts: this.formatTimestamp(await this.getBlockTimestamp(event.blockNumber)),
          wallet_address: event.args.sender,
          amount: ethers.formatEther(event.args.amount),
          tx_hash: event.transactionHash,
          block_number: event.blockNumber
        });
      }
      
      // 驗證數據完整性
      const validation = this.validateDataIntegrity(roundData, betData, claimData);
      if (!validation.valid) {
        console.log(`❌ 回合 ${epoch} 數據完整性驗證失敗: ${validation.reason}`);
        const shouldSkip = await this.handleEpochFailure(epoch, validation.reason);
        return !shouldSkip;
      }
      
      // 使用事務保存完整數據
      const success = await this.db.saveCompleteRoundData(roundData, betData, claimData);
      
      if (success) {
        // 🧹 強制清理 realbets 表中的重複數據（防止錯亂）
        try {
          const deletedCount = await this.db.deleteRealBetsByEpoch(epoch);
          console.log(`🧹 已清理 realbets 表中回合 ${epoch} 的 ${deletedCount} 筆數據`);
        } catch (error) {
          console.error(`⚠️ 清理 realbets 回合 ${epoch} 失敗:`, error.message);
          // 不影響主流程，繼續執行
        }
        
        // 🎯 統一以局號為批次：只清理當前處理的局次，避免跨局次數據混亂
        console.log(`✅ 統一批次處理：僅清理當前局次 ${epoch} 的 realbets 數據，避免跨局次混亂`)
        
        // 清除失敗記錄
        this.failedAttempts.delete(epoch);
        
        console.log(`✅ 回合 ${epoch} 數據處理完成 (${betData.length} 筆下注, ${claimData.length} 筆領獎)`);
        return true;
      } else {
        console.log(`❌ 回合 ${epoch} 數據保存失敗`);
        return false;
      }
      
    } catch (error) {
      console.error(`❌ 處理回合 ${epoch} 失敗:`, error.message);
      await this.handleEpochFailure(epoch, error.message);
      return false;
    }
  }

  // 統一處理下注事件
  async processBetEvents(events, direction, betData, roundResult) {
    for (const event of events) {
      // 計算WIN/LOSS結果
      let result = null;
      if (roundResult) {
        result = (direction === roundResult) ? 'WIN' : 'LOSS';
      }
      
      betData.push({
        epoch: Number(event.args.epoch),
        bet_ts: this.formatTimestamp(await this.getBlockTimestamp(event.blockNumber)),
        wallet_address: event.args.sender,
        bet_direction: direction,
        amount: ethers.formatEther(event.args.amount),
        result: result,
        tx_hash: event.transactionHash,
        block_number: event.blockNumber
      });
    }
  }

  // 統一處理失敗重試邏輯
  async handleEpochFailure(epoch, reason) {
    const attempts = this.failedAttempts.get(epoch) || 0;
    this.failedAttempts.set(epoch, attempts + 1);
    
    if (attempts + 1 >= 3) {
      await this.db.recordFailedEpoch(epoch, reason);
      console.log(`🚫 回合 ${epoch} 重試 3 次仍失敗，已記錄並跳過`);
      this.failedAttempts.delete(epoch);
      return true; // 應該跳過
    }
    
    await this.db.deleteRoundData(epoch);
    console.log(`🗑️ 已刪除回合 ${epoch} 的不完整數據，將重試 (${attempts + 1}/3)`);
    return false; // 不跳過，繼續重試
  }

  // 統一的回合處理邏輯
  async processEpochIfNeeded(targetEpoch, skipMessage = '已存在') {
    if (await this.hasRoundData(targetEpoch)) {
      console.log(`⏭️ 回合 ${targetEpoch} ${skipMessage}，跳過`);
      return false;
    }
    return await this.processEpochData(targetEpoch);
  }

  // 統一的延遲處理
  async delayMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 統一的定時任務啟動
  scheduleTask(taskFunction, delay, description) {
    setTimeout(() => {
      console.log(`🔄 啟動 ${description}`);
      taskFunction();
    }, delay);
  }

  // 獲取區塊時間戳
  async getBlockTimestamp(blockNumber) {
    try {
      const block = await this.retryRequest(
        () => this.provider.getBlock(blockNumber),
        `獲取區塊 ${blockNumber} 時間戳`
      );
      return block ? block.timestamp : Math.floor(Date.now() / 1000);
    } catch (error) {
      console.error(`獲取區塊 ${blockNumber} 時間戳失敗:`, error.message);
      return Math.floor(Date.now() / 1000);
    }
  }

  // 處理最新數據（當前回合-2到-6）
  async processLatestData() {
    try {
      const currentEpoch = await this.getCurrentEpoch();
      console.log(`🔄 開始處理最新數據，當前回合: ${currentEpoch}`);
      
      // 處理最近5個已結束的回合（當前-2到-6）
      for (let i = 2; i <= 6; i++) {
        const targetEpoch = currentEpoch - i;
        
        if (targetEpoch <= 0) continue;
        
        await this.processEpochIfNeeded(targetEpoch);
        await this.delayMs(1000);
      }
      
    } catch (error) {
      console.error('❌ 處理最新數據失敗:', error.message);
    }
  }

  // 處理歷史數據回補（連續運行）
  async processHistoryData() {
    if (this.isProcessingHistory) {
      console.log('⏳ 歷史數據處理中，跳過本次');
      return;
    }
    
    this.isProcessingHistory = true;
    this.shouldStopHistory = false;
    
    try {
      const currentEpoch = await this.getCurrentEpoch();
      let checkEpoch = currentEpoch - 2;
      
      console.log(`📚 開始歷史回補，從回合 ${checkEpoch} 往回檢查...`);
      
      // 從最新-2開始，一路往回處理沒有數據的回合
      while (this.isProcessingHistory && !this.shouldStopHistory) {
        try {
          // 檢查是否已有數據
          if (!(await this.hasRoundData(checkEpoch))) {
            console.log(`🔄 開始處理回合 ${checkEpoch}`);
            await this.processEpochData(checkEpoch);
          } else {
            console.log(`⏭️ 回合 ${checkEpoch} 已存在，跳過`);
          }
          
          checkEpoch--;
          
          // 檢查是否需要停止
          if (this.shouldStopHistory) {
            console.log(`🛑 收到停止信號，當前回合 ${checkEpoch + 1} 處理完成`);
            break;
          }
          
          await this.delayMs(2000); // 每個回合間隔2秒
          
        } catch (error) {
          console.error(`❌ 處理回合 ${checkEpoch} 失敗:`, error.message);
          checkEpoch--; // 跳過失敗的回合
        }
      }
      
    } catch (error) {
      console.error('❌ 歷史數據回補失敗:', error.message);
    } finally {
      this.isProcessingHistory = false;
      this.shouldStopHistory = false;
    }
  }

  // 啟動定期任務
  startPeriodicTasks() {
    console.log('🚀 啟動定期任務');
    
    // 每5分鐘處理最新數據
    setInterval(() => {
      this.processLatestData();
    }, 5 * 60 * 1000);
    
    // 歷史回補：啟動後立即開始，每30分鐘重啟一次
    this.startHistoryBackfill();
    this.historyInterval = setInterval(async () => {
      await this.stopHistoryBackfill();
      setTimeout(() => this.startHistoryBackfill(), 5000); // 5秒後重啟
    }, 30 * 60 * 1000);
    
    // 5分鐘後開始執行最新數據處理
    this.scheduleTask(() => this.processLatestData(), 5 * 60 * 1000, '最新數據處理');
  }

  // 啟動歷史回補
  startHistoryBackfill() {
    console.log('🔄 啟動歷史數據回補');
    setTimeout(() => this.processHistoryData(), 10000); // 10秒後開始
  }

  // 停止歷史回補（優雅關閉）
  async stopHistoryBackfill() {
    if (!this.isProcessingHistory) {
      console.log('📋 歷史數據回補未運行，無需停止');
      return;
    }
    
    console.log('🛑 請求停止歷史數據回補，等待當前回合處理完成...');
    this.shouldStopHistory = true;
    
    // 等待歷史回補優雅結束
    while (this.isProcessingHistory) {
      await this.delayMs(1000);
    }
    
    console.log('✅ 歷史數據回補已優雅停止');
  }

  // 停止抓取器
  async stop() {
    console.log('🛑 停止一體化數據抓取器');
    await this.stopHistoryBackfill();
    if (this.historyInterval) {
      clearInterval(this.historyInterval);
    }
    if (this.db) {
      await this.db.close();
    }
  }
}

// 如果直接運行此文件
if (require.main === module) {
  const crawler = new UnifiedDataCrawler();
  
  crawler.initialize()
    .then(() => {
      crawler.startPeriodicTasks();
    })
    .catch(error => {
      console.error('❌ 啟動失敗:', error);
      process.exit(1);
    });
  
  // 優雅關閉
  process.on('SIGINT', async () => {
    console.log('\n🛑 收到停止信號，正在關閉...');
    await crawler.stop();
    process.exit(0);
  });
}

module.exports = UnifiedDataCrawler;