const { Pool } = require('pg');
const TimeUtils = require('./time-utils');

class DatabaseV4 {
  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_vXlY01CQdqTh@ep-billowing-smoke-a13osu4w-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require&timezone=Asia/Taipei',
      ssl: {
        rejectUnauthorized: false
      }
    });
    
    this.queries = {
      insertRound: `
        INSERT INTO rounds (
          epoch, start_ts, lock_ts, close_ts, lock_price, close_price, 
          result, total_amount, up_amount, down_amount, up_payout, down_payout
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (epoch) 
        DO UPDATE SET
          start_ts = EXCLUDED.start_ts,
          lock_ts = EXCLUDED.lock_ts,
          close_ts = EXCLUDED.close_ts,
          lock_price = EXCLUDED.lock_price,
          close_price = EXCLUDED.close_price,
          result = EXCLUDED.result,
          total_amount = EXCLUDED.total_amount,
          up_amount = EXCLUDED.up_amount,
          down_amount = EXCLUDED.down_amount,
          up_payout = EXCLUDED.up_payout,
          down_payout = EXCLUDED.down_payout
      `,
      insertBet: `
        INSERT INTO hisbets (
          epoch, bet_ts, wallet_address, bet_direction, amount, result, tx_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tx_hash) DO NOTHING
      `,
      insertClaim: `
        INSERT INTO claims (
          epoch, claim_ts, wallet_address, claim_amount, bet_epoch, tx_hash
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tx_hash) DO NOTHING
      `,
      deleteClaims: 'DELETE FROM claims WHERE bet_epoch = $1',
      deleteBets: 'DELETE FROM hisbets WHERE epoch = $1', 
      deleteRounds: 'DELETE FROM rounds WHERE epoch = $1',
      deleteRealBets: 'DELETE FROM realbets WHERE epoch = $1',
      countRounds: 'SELECT COUNT(*) as count FROM rounds WHERE epoch = $1'
    };
  }

  async initialize() {
    try {
      // 設置會話時區為台北時間
      await this.pool.query("SET timezone = 'Asia/Taipei'");
      
      const timeResult = await this.pool.query('SELECT NOW() as current_time, current_setting(\'timezone\') as timezone');
      console.log('✅ PostgreSQL 連接成功');
      console.log(`📅 數據庫時區設置: ${timeResult.rows[0].timezone}`);
      console.log(`🕐 數據庫當前時間: ${this.formatTimestamp(timeResult.rows[0].current_time)}`);
      
      await this.createTables();
      console.log('✅ 數據庫表初始化完成');
    } catch (error) {
      console.error('❌ 數據庫初始化失敗:', error.message);
      throw error;
    }
  }

  async createTables() {
    const queries = [
      `CREATE TABLE IF NOT EXISTS rounds (
        epoch BIGINT PRIMARY KEY,
        start_ts TIMESTAMPTZ,
        lock_ts TIMESTAMPTZ,
        close_ts TIMESTAMPTZ,
        lock_price NUMERIC,
        close_price NUMERIC,
        result VARCHAR(10),
        total_amount NUMERIC,
        up_amount NUMERIC,
        down_amount NUMERIC,
        up_payout NUMERIC,
        down_payout NUMERIC
      )`,
      
      `CREATE TABLE IF NOT EXISTS hisbets (
        epoch BIGINT,
        bet_ts TIMESTAMPTZ,
        wallet_address VARCHAR(42),
        bet_direction VARCHAR(4),
        amount NUMERIC,
        result VARCHAR(4),
        tx_hash VARCHAR(66),
        UNIQUE(tx_hash)
      )`,
      
      `CREATE TABLE IF NOT EXISTS realbets (
        epoch BIGINT,
        bet_ts TIMESTAMPTZ,
        wallet_address VARCHAR(42),
        bet_direction VARCHAR(4),
        amount NUMERIC,
        tx_hash VARCHAR(66),
        block_number BIGINT,
        UNIQUE(tx_hash)
      )`,

      `CREATE TABLE IF NOT EXISTS claims (
        epoch BIGINT,
        claim_ts TIMESTAMPTZ,
        wallet_address VARCHAR(42),
        claim_amount NUMERIC,
        bet_epoch BIGINT,
        tx_hash VARCHAR(66),
        UNIQUE(tx_hash)
      )`,

      `CREATE TABLE IF NOT EXISTS failed_epochs (
        epoch BIGINT PRIMARY KEY,
        failure_count INTEGER DEFAULT 1,
        last_attempt_ts TIMESTAMPTZ DEFAULT NOW(),
        error_message TEXT,
        created_ts TIMESTAMPTZ DEFAULT NOW()
      )`,

      `CREATE TABLE IF NOT EXISTS wallet_notes (
        wallet_address VARCHAR(42) PRIMARY KEY,
        note TEXT,
        updated_ts TIMESTAMPTZ DEFAULT NOW()
      )`,
      
      `CREATE INDEX IF NOT EXISTS idx_rounds_epoch ON rounds(epoch)`,
      `CREATE INDEX IF NOT EXISTS idx_hisbets_epoch ON hisbets(epoch)`,
      `CREATE INDEX IF NOT EXISTS idx_hisbets_wallet ON hisbets(wallet_address)`,
      `CREATE INDEX IF NOT EXISTS idx_hisbets_ts ON hisbets(bet_ts)`,
      `CREATE INDEX IF NOT EXISTS idx_realbets_epoch ON realbets(epoch)`,
      `CREATE INDEX IF NOT EXISTS idx_realbets_wallet ON realbets(wallet_address)`,
      `CREATE INDEX IF NOT EXISTS idx_realbets_block ON realbets(block_number)`,
      `CREATE INDEX IF NOT EXISTS idx_claims_epoch ON claims(epoch)`,
      `CREATE INDEX IF NOT EXISTS idx_claims_wallet ON claims(wallet_address)`,
      `CREATE INDEX IF NOT EXISTS idx_claims_bet_epoch ON claims(bet_epoch)`,
      `CREATE INDEX IF NOT EXISTS idx_failed_epochs_count ON failed_epochs(failure_count)`,
      `CREATE INDEX IF NOT EXISTS idx_failed_epochs_ts ON failed_epochs(last_attempt_ts)`
    ];

    for (const query of queries) {
      await this.pool.query(query);
    }
  }

  async insertRound(roundData) {
    await this.pool.query(this.queries.insertRound, this.extractValues(roundData, 'insertRound'));
  }

  async insertBet(betData) {
    await this.pool.query(this.queries.insertBet, this.extractValues(betData, 'insertBet'));
  }

  async hasRound(epoch) {
    return await this.hasRecords('countRounds', epoch);
  }

  async getRound(epoch) {
    const query = 'SELECT * FROM rounds WHERE epoch = $1';
    const result = await this.pool.query(query, [epoch]);
    
    if (result.rows[0]) {
      const round = result.rows[0];
      return {
        ...round,
        start_ts: round.start_ts ? this.formatTimestamp(round.start_ts) : null,
        lock_ts: round.lock_ts ? this.formatTimestamp(round.lock_ts) : null,
        close_ts: round.close_ts ? this.formatTimestamp(round.close_ts) : null
      };
    }
    return null;
  }

  async insertRealBet(betData) {
    const query = `
      INSERT INTO realbets (
        epoch, bet_ts, wallet_address, bet_direction, amount, tx_hash, block_number
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tx_hash) DO NOTHING
    `;
    
    const values = [
      betData.epoch,
      betData.bet_ts,
      betData.wallet_address,
      betData.bet_direction,
      betData.amount,
      betData.tx_hash,
      betData.block_number
    ];
    
    await this.pool.query(query, values);
  }

  async getRealBetsByEpoch(epoch) {
    const query = 'SELECT * FROM realbets WHERE epoch = $1 ORDER BY bet_ts';
    const result = await this.pool.query(query, [epoch]);
    
    return result.rows.map(bet => ({
      ...bet,
      bet_ts: this.formatTimestamp(bet.bet_ts)
    }));
  }

  async getBetsByEpoch(epoch) {
    const query = 'SELECT * FROM hisbets WHERE epoch = $1 ORDER BY bet_ts';
    const result = await this.pool.query(query, [epoch]);
    
    return result.rows.map(bet => ({
      epoch: bet.epoch,
      timestamp: this.formatTimestamp(bet.bet_ts),
      wallet: bet.wallet_address,
      direction: bet.bet_direction,
      amount: parseFloat(bet.amount),
      result: null,
      tx_hash: bet.tx_hash,
      source: 'history',  // 🔧 修復：hisbets數據應標記為history而非realtime
    }));
  }

  // 🎯 獲取指定錢包的歷史下注數據 - 支持個人48局勝負分析
  async getWalletHistoryBets(wallet, startEpoch, endEpoch) {
    const query = `
      SELECT epoch, bet_ts, wallet_address, bet_direction, amount, result, tx_hash
      FROM hisbets 
      WHERE wallet_address = $1 AND epoch BETWEEN $2 AND $3 
      ORDER BY epoch DESC, bet_ts ASC
    `;
    
    console.log(`🔍 查詢錢包 ${wallet} 歷史下注範圍: ${startEpoch} → ${endEpoch}`);
    // 🔧 修復：不轉換錢包地址大小寫，保持原始格式
    const result = await this.pool.query(query, [wallet, endEpoch, startEpoch]);
    
    console.log(`   數據庫返回 ${result.rows.length} 筆記錄`);
    return result.rows.map(bet => ({
      ...bet,
      bet_ts: this.formatTimestamp(bet.bet_ts)
    }));
  }


  // 📝 保存/更新錢包備註
  async updateWalletNote(wallet, note) {
    const query = `
      INSERT INTO wallet_notes (wallet_address, note, updated_ts)
      VALUES ($1, $2, NOW())
      ON CONFLICT (wallet_address)
      DO UPDATE SET note = EXCLUDED.note, updated_ts = NOW()
    `;
    
    try {
      await this.pool.query(query, [wallet.toLowerCase(), note]);
      return true;
    } catch (error) {
      console.error(`❌ 保存錢包備註失敗:`, error);
      return false;
    }
  }

  formatTimestamp(timestamp) {
    return TimeUtils.formatTimestamp(timestamp);
  }

  // 🕐 創建台北時間的時間戳
  createTaipeiTimestamp(date = new Date()) {
    return TimeUtils.createTaipeiTimestamp(date);
  }

  async hasRecords(queryKey, epoch) {
    const result = await this.pool.query(this.queries[queryKey], [epoch]);
    return parseInt(result.rows[0].count) > 0;
  }

  extractBetValues(data) {
    return [
      data.epoch, data.bet_ts, data.wallet_address,
      data.bet_direction, data.amount, data.result, data.tx_hash
    ];
  }

  extractClaimValues(data) {
    return [
      data.epoch, data.claim_ts, data.wallet_address,
      data.amount || data.claim_amount, data.bet_epoch || data.epoch, data.tx_hash
    ];
  }

  extractRoundValues(data) {
    return [
      data.epoch, data.start_ts, data.lock_ts, data.close_ts,
      data.lock_price, data.close_price, data.result, data.total_amount,
      data.up_amount, data.down_amount, data.up_payout, data.down_payout
    ];
  }

  extractValues(data, queryKey) {
    switch (queryKey) {
      case 'insertBet':
        return this.extractBetValues(data);
      case 'insertClaim':
        return this.extractClaimValues(data);
      case 'insertRound':
        return this.extractRoundValues(data);
      default:
        throw new Error(`Unknown query key: ${queryKey}`);
    }
  }

  async getWalletBetsInRange(wallet, startEpoch, endEpoch) {
    const query = `
      SELECT * FROM hisbets 
      WHERE wallet_address = $1 AND epoch >= $2 AND epoch <= $3 
      ORDER BY epoch
    `;
    const result = await this.pool.query(query, [wallet, startEpoch, endEpoch]);
    return result.rows.map(bet => ({
      ...bet,
      bet_ts: this.formatTimestamp(bet.bet_ts)
    }));
  }

  async getRoundResultsInRange(startEpoch, endEpoch) {
    const query = `
      SELECT epoch, result as winner FROM rounds 
      WHERE epoch >= $1 AND epoch <= $2 AND result IS NOT NULL
      ORDER BY epoch
    `;
    const result = await this.pool.query(query, [startEpoch, endEpoch]);
    return result.rows;
  }

  async getLatestRound() {
    const query = 'SELECT epoch FROM rounds ORDER BY epoch DESC LIMIT 1';
    const result = await this.pool.query(query);
    return result.rows[0] || null;
  }

  // 🔔 PostgreSQL NOTIFY - 發送通知
  async notify(channel, payload) {
    try {
      const escapedPayload = payload.replace(/'/g, "''"); // 轉義單引號
      await this.pool.query(`NOTIFY ${channel}, '${escapedPayload}'`);
    } catch (error) {
      console.error(`❌ 發送通知失敗 (${channel}):`, error);
    }
  }

  // 👂 PostgreSQL LISTEN - 監聽通知
  async listen(channel, callback) {
    try {
      // 創建專用的監聽連接
      const client = await this.pool.connect();
      
      // 設置監聽
      await client.query(`LISTEN ${channel}`);
      console.log(`👂 開始監聽數據庫通知: ${channel}`);
      
      // 處理通知事件
      client.on('notification', (msg) => {
        if (msg.channel === channel) {
          try {
            const payload = JSON.parse(msg.payload);
            callback(payload);
          } catch (error) {
            console.error(`❌ 解析通知數據失敗 (${channel}):`, error);
            // 如果JSON解析失敗，傳遞原始字符串
            callback(msg.payload);
          }
        }
      });
      
      // 返回客戶端以便後續關閉
      return client;
      
    } catch (error) {
      console.error(`❌ 設置數據庫監聽失敗 (${channel}):`, error);
      throw error;
    }
  }

  async close() {
    await this.pool.end();
    console.log('✅ 數據庫連接已關閉');
  }

  async getWalletNote(wallet) {
    const query = 'SELECT note FROM wallet_notes WHERE wallet_address = $1';
    const result = await this.pool.query(query, [wallet]);
    return result.rows[0]?.note || '';
  }


  // unified-crawler.js 需要的方法
  async insertClaim(claimData) {
    await this.pool.query(this.queries.insertClaim, this.extractValues(claimData, 'insertClaim'));
  }

  async shouldSkipEpoch(epoch) {
    const query = 'SELECT failure_count FROM failed_epochs WHERE epoch = $1 AND failure_count >= 3';
    const result = await this.pool.query(query, [epoch]);
    return result.rows.length > 0;
  }

  async recordFailedEpoch(epoch, errorMessage) {
    const query = `
      INSERT INTO failed_epochs (epoch, failure_count, last_attempt_ts, error_message)
      VALUES ($1, 1, NOW(), $2)
      ON CONFLICT (epoch)
      DO UPDATE SET
        failure_count = failed_epochs.failure_count + 1,
        last_attempt_ts = NOW(),
        error_message = EXCLUDED.error_message
      RETURNING failure_count
    `;
    
    const result = await this.pool.query(query, [epoch, errorMessage]);
    const failureCount = result.rows[0].failure_count;
    
    if (failureCount >= 3) {
      console.log(`🚨 警告：回合 ${epoch} 已失敗 ${failureCount} 次，暫停抓取`);
    } else {
      console.log(`⚠️ 回合 ${epoch} 失敗第 ${failureCount} 次，錯誤：${errorMessage}`);
    }
    
    return failureCount;
  }

  async deleteRoundData(epoch) {
    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        
        const claimsResult = await client.query(this.queries.deleteClaims, [epoch]);
        const betsResult = await client.query(this.queries.deleteBets, [epoch]);  
        const roundsResult = await client.query(this.queries.deleteRounds, [epoch]);
        
        await client.query('COMMIT');
        
        console.log(`🗑️ 已刪除回合 ${epoch} 的所有數據:`);
        console.log(`   - rounds: ${roundsResult.rowCount} 筆`);
        console.log(`   - hisbets: ${betsResult.rowCount} 筆`);
        console.log(`   - claims: ${claimsResult.rowCount} 筆`);
        
        return {
          rounds: roundsResult.rowCount,
          hisbets: betsResult.rowCount,
          claims: claimsResult.rowCount
        };
        
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error(`❌ 刪除回合 ${epoch} 數據失敗:`, error.message);
      throw error;
    }
  }

  async deleteRealBetsByEpoch(epoch) {
    const result = await this.pool.query(this.queries.deleteRealBets, [epoch]);
    return result.rowCount;
  }

  async saveCompleteRoundData(roundData, betData, claimData) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      // 插入回合數據
      await client.query(this.queries.insertRound, this.extractValues(roundData, 'insertRound'));
      
      // 批量插入下注數據
      for (const bet of betData) {
        await client.query(this.queries.insertBet, this.extractValues(bet, 'insertBet'));
      }
      
      // 批量插入領獎數據
      for (const claim of claimData) {
        await client.query(this.queries.insertClaim, this.extractValues(claim, 'insertClaim'));
      }
      
      await client.query('COMMIT');
      console.log(`✅ 事務完成 - 回合 ${roundData.epoch} 所有數據已保存`);
      return true;
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`❌ 事務失敗 - 回合 ${roundData.epoch}:`, error.message);
      return false;
    } finally {
      client.release();
    }
  }
}

module.exports = DatabaseV4;