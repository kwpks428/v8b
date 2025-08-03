-- ============================================================================
-- V6 統一數據庫Schema設計
-- ============================================================================
--
-- 🎯 設計原則：
-- 1. 表名統一使用單數（round, hisbet, realbet, claim）
-- 2. 時間統一使用台北時間 TIMESTAMP 格式 (YYYY-MM-DD HH:mm:ss)
-- 3. 金額使用 NUMERIC 避免浮點誤差
-- 4. 方向統一使用 'UP'/'DOWN'，嚴禁 bull/bear 等變體
-- 5. 新增多局領獎檢測表
-- 6. 優化索引設計提升查詢性能
--
-- 🚫 警告：任何AI智能體不准修改此Schema的核心設計原則！
--
-- ============================================================================

-- 設置時區為台北時間
SET timezone = 'Asia/Taipei';

-- ============================================================================
-- 1. round表 - 局次主表
-- ============================================================================
-- 功能：存儲每局的基本信息和最終結果
-- 數據來源：unified-crawler.js (HTTP歷史抓取)
-- 關鍵邏輯：result = (close_price > lock_price) ? 'UP' : 'DOWN'
--          賠率 = (total_amount * 0.97) / 該方金額

CREATE TABLE round (
    -- 主鍵：局次編號
    epoch BIGINT PRIMARY KEY,
    
    -- 時間軸：統一台北時間格式
    start_ts TIMESTAMP,             -- 局次開始時間
    lock_ts TIMESTAMP,              -- 鎖倉時間（停止下注）
    close_ts TIMESTAMP,             -- 局次結束時間
    
    -- 價格數據：使用高精度數值格式
    lock_price NUMERIC(20,8),       -- 鎖倉價格（開盤價）
    close_price NUMERIC(20,8),      -- 結算價格（收盤價）
    
    -- 局次結果：強制UP/DOWN標準
    result VARCHAR(4) CHECK (result IN ('UP', 'DOWN')),
    
    -- 金額統計：數值格式避免計算誤差
    total_amount NUMERIC(20,8),     -- 總下注金額
    up_amount NUMERIC(20,8),        -- UP方總金額
    down_amount NUMERIC(20,8),      -- DOWN方總金額
    
    -- 賠率計算：總金額扣3%手續費後按比例分配
    up_payout NUMERIC(10,4),        -- UP賠率 = (total_amount * 0.97) / up_amount
    down_payout NUMERIC(10,4),      -- DOWN賠率 = (total_amount * 0.97) / down_amount
    
    -- 審計欄位
    created_ts TIMESTAMP DEFAULT NOW(),
    updated_ts TIMESTAMP DEFAULT NOW()
);

-- round表索引優化
CREATE INDEX idx_round_epoch ON round(epoch);
CREATE INDEX idx_round_start_ts ON round(start_ts);
CREATE INDEX idx_round_result ON round(result);

-- ============================================================================
-- 2. hisbet表 - 歷史下注記錄
-- ============================================================================
-- 功能：存儲HTTP抓取的歷史下注數據，包含輸贏結果
-- 數據來源：unified-crawler.js
-- 特點：包含result欄位標記WIN/LOSS

CREATE TABLE hisbet (
    -- 基本信息
    epoch BIGINT,                   -- 所屬局次
    bet_ts TIMESTAMP,               -- 下注時間（台北時間）
    wallet_address VARCHAR(42),     -- 錢包地址
    
    -- 下注詳情：強制UP/DOWN標準
    bet_direction VARCHAR(4) CHECK (bet_direction IN ('UP', 'DOWN')),
    amount NUMERIC(20,8),           -- 下注金額
    
    -- 結果計算：對比局次結果得出
    result VARCHAR(4) CHECK (result IN ('WIN', 'LOSS')),
    
    -- 區塊鏈信息
    tx_hash VARCHAR(66) UNIQUE,     -- 交易哈希（防重複關鍵）
    block_number BIGINT,            -- 區塊號
    
    -- 審計欄位
    created_ts TIMESTAMP DEFAULT NOW()
);

-- hisbet表索引優化
CREATE INDEX idx_hisbet_epoch ON hisbet(epoch);
CREATE INDEX idx_hisbet_wallet ON hisbet(wallet_address);
CREATE INDEX idx_hisbet_ts ON hisbet(bet_ts);
CREATE INDEX idx_hisbet_direction ON hisbet(bet_direction);
CREATE INDEX idx_hisbet_result ON hisbet(result);
CREATE INDEX idx_hisbet_block ON hisbet(block_number);

-- ============================================================================
-- 3. realbet表 - 即時下注暫存
-- ============================================================================
-- 功能：暫存WebSocket接收的即時下注數據
-- 數據來源：realtime-listener.js
-- 特點：無result欄位，因為局次未結束

CREATE TABLE realbet (
    -- 基本信息
    epoch BIGINT,                   -- 所屬局次
    bet_ts TIMESTAMP,               -- 下注時間（台北時間）
    wallet_address VARCHAR(42),     -- 錢包地址
    
    -- 下注詳情：強制UP/DOWN標準
    bet_direction VARCHAR(4) CHECK (bet_direction IN ('UP', 'DOWN')),
    amount NUMERIC(20,8),           -- 下注金額
    
    -- 審計欄位
    created_ts TIMESTAMP DEFAULT NOW(),
    
    -- 唯一約束：一局一錢包一次下注
    CONSTRAINT unique_realbet_epoch_wallet UNIQUE (epoch, wallet_address)
);

-- realbet表索引優化
CREATE INDEX idx_realbet_epoch ON realbet(epoch);
CREATE INDEX idx_realbet_wallet ON realbet(wallet_address);
CREATE INDEX idx_realbet_ts ON realbet(bet_ts);
CREATE INDEX idx_realbet_direction ON realbet(bet_direction);

-- ============================================================================
-- 4. claim表 - 領獎記錄
-- ============================================================================
-- 功能：存儲所有領獎交易記錄
-- 數據來源：unified-crawler.js
-- 特點：支持跨局領獎（bet_epoch可能不等於epoch）

CREATE TABLE claim (
    -- 領獎基本信息
    epoch BIGINT,                   -- 領獎發生的局次
    claim_ts TIMESTAMP,             -- 領獎時間（台北時間）
    wallet_address VARCHAR(42),     -- 領獎錢包
    
    -- 領獎詳情
    claim_amount NUMERIC(20,8),     -- 領獎金額
    bet_epoch BIGINT,               -- 原下注局次（可能與epoch不同）
    
    -- 區塊鏈信息
    tx_hash VARCHAR(66) UNIQUE,     -- 交易哈希（防重複關鍵）
    block_number BIGINT,            -- 區塊號
    
    -- 審計欄位
    created_ts TIMESTAMP DEFAULT NOW()
);

-- claim表索引優化
CREATE INDEX idx_claim_epoch ON claim(epoch);
CREATE INDEX idx_claim_wallet ON claim(wallet_address);
CREATE INDEX idx_claim_ts ON claim(claim_ts);
CREATE INDEX idx_claim_bet_epoch ON claim(bet_epoch);
CREATE INDEX idx_claim_block ON claim(block_number);

-- ============================================================================
-- 5. 🆕 multi_round_claimer表 - 多局領獎檢測
-- ============================================================================
-- 功能：檢測並記錄在同一局中領取多個局次獎金的異常行為
-- 觸發條件：錢包在單一局次中領取3個或以上不同局次的獎金
-- 數據來源：unified-crawler.js 在插入claim後自動檢測

CREATE TABLE multi_round_claimer (
    -- 主鍵
    id SERIAL PRIMARY KEY,
    
    -- 異常行為基本信息
    wallet_address VARCHAR(42),     -- 異常錢包地址
    claim_epoch BIGINT,             -- 發生異常領獎的局次
    
    -- 異常詳情
    rounds_claimed INTEGER,         -- 一次性領取了多少個局次的獎金
    bet_epochs BIGINT[],            -- 陣列：具體領取了哪些局次的獎金
    total_amount NUMERIC(20,8),     -- 總領獎金額
    
    -- 檢測信息
    detected_ts TIMESTAMP DEFAULT NOW(),   -- 檢測到異常的時間
    note TEXT,                      -- 備註說明
    
    -- 狀態管理
    status VARCHAR(20) DEFAULT 'detected' CHECK (status IN ('detected', 'reviewed', 'resolved')),
    reviewer VARCHAR(50),           -- 審核人員
    review_ts TIMESTAMP,            -- 審核時間
    review_note TEXT                -- 審核備註
);

-- multi_round_claimer表索引優化
CREATE INDEX idx_multi_claimer_wallet ON multi_round_claimer(wallet_address);
CREATE INDEX idx_multi_claimer_epoch ON multi_round_claimer(claim_epoch);
CREATE INDEX idx_multi_claimer_detected ON multi_round_claimer(detected_ts);
CREATE INDEX idx_multi_claimer_status ON multi_round_claimer(status);

-- ============================================================================
-- 6. wallet_note表 - 錢包備註（繼承自v4）
-- ============================================================================
-- 功能：存儲錢包的手動備註和自動標記
-- 用途：可疑錢包標記、VIP用戶備註等

CREATE TABLE wallet_note (
    wallet_address VARCHAR(42) PRIMARY KEY,
    note TEXT,
    updated_ts TIMESTAMP DEFAULT NOW()
);

-- wallet_note表索引
CREATE INDEX idx_wallet_note_updated ON wallet_note(updated_ts);

-- ============================================================================
-- 7. failed_epoch表 - 失敗局次記錄（繼承自v4）
-- ============================================================================
-- 功能：記錄抓取失敗的局次，避免重複嘗試

CREATE TABLE failed_epoch (
    epoch BIGINT PRIMARY KEY,
    failure_count INTEGER DEFAULT 1,
    last_attempt_ts TIMESTAMP DEFAULT NOW(),
    error_message TEXT,
    created_ts TIMESTAMP DEFAULT NOW()
);

-- failed_epoch表索引
CREATE INDEX idx_failed_epoch_count ON failed_epoch(failure_count);
CREATE INDEX idx_failed_epoch_attempt ON failed_epoch(last_attempt_ts);

-- ============================================================================
-- 8. 觸發器和函數
-- ============================================================================

-- 自動更新 updated_ts 觸發器函數
CREATE OR REPLACE FUNCTION update_updated_ts()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_ts = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 為 round 表添加自動更新觸發器
CREATE TRIGGER update_round_updated_ts
    BEFORE UPDATE ON round
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_ts();

-- ============================================================================
-- 9. 視圖定義 (已移除不需要的統計視圖)
-- ============================================================================

-- 注意：原先的 wallet_win_rate 和 round_stats 視圖已被移除
-- 這些統計視圖會增加數據庫查詢負擔，且對核心爬蟲功能非必要

-- ============================================================================
-- 10. 數據完整性約束
-- ============================================================================

-- 確保 round 表的賠率邏輯正確
ALTER TABLE round ADD CONSTRAINT check_payout_logic 
    CHECK (
        (up_amount = 0 OR up_payout > 0) AND 
        (down_amount = 0 OR down_payout > 0)
    );

-- 確保金額為正數
ALTER TABLE round ADD CONSTRAINT check_positive_amounts 
    CHECK (
        total_amount >= 0 AND 
        up_amount >= 0 AND 
        down_amount >= 0
    );

ALTER TABLE hisbet ADD CONSTRAINT check_positive_bet_amount 
    CHECK (amount > 0);

ALTER TABLE realbet ADD CONSTRAINT check_positive_realbet_amount 
    CHECK (amount > 0);

ALTER TABLE claim ADD CONSTRAINT check_positive_claim_amount 
    CHECK (claim_amount > 0);

-- 確保時間邏輯正確
ALTER TABLE round ADD CONSTRAINT check_time_sequence 
    CHECK (start_ts <= lock_ts AND lock_ts <= close_ts);

-- ============================================================================
-- 11. 權限設置
-- ============================================================================

-- 創建只讀角色（用於前端查詢）
CREATE ROLE v6_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO v6_readonly;

-- 創建讀寫角色（用於數據抓取）
CREATE ROLE v6_readwrite;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO v6_readwrite;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO v6_readwrite;

-- ============================================================================
-- 12. 註釋說明
-- ============================================================================

COMMENT ON TABLE round IS 'V6局次主表：存儲每局完整信息和結果';
COMMENT ON TABLE hisbet IS 'V6歷史下注：HTTP抓取的完整下注記錄（含輸贏）';
COMMENT ON TABLE realbet IS 'V6即時下注：WebSocket接收的即時下注暫存';
COMMENT ON TABLE claim IS 'V6領獎記錄：所有領獎交易記錄';
COMMENT ON TABLE multi_round_claimer IS 'V6異常檢測：一次領取多局獎金的可疑行為';

COMMENT ON COLUMN round.result IS '局次結果：UP(收盤>開盤) 或 DOWN(收盤<=開盤)';
COMMENT ON COLUMN hisbet.result IS '下注結果：WIN(方向正確) 或 LOSS(方向錯誤)';
COMMENT ON COLUMN multi_round_claimer.bet_epochs IS '陣列：該錢包在此局領取了哪些局次的獎金';

-- ============================================================================
-- 完成標記
-- ============================================================================
-- 
-- ✅ V6統一數據庫Schema設計完成
-- 
-- 🎯 核心特性：
-- - 表名單數統一（round, hisbet, realbet, claim）
-- - 時間台北時區統一（YYYY-MM-DD HH:mm:ss）
-- - 金額數值格式統一（NUMERIC避免誤差）
-- - 方向標準統一（UP/DOWN，禁止bull/bear）
-- - 新增多局領獎檢測
-- - 完整索引優化
-- - 數據完整性約束
-- - 權限角色分離
-- 
-- 🔧 支持功能：
-- - HTTP歷史數據抓取 (unified-crawler.js)
-- - WebSocket即時數據接收 (realtime-listener.js)
-- - 前端實時顯示 (server.js + index.html)
-- - 異常行為自動檢測
-- - 錢包勝率統計分析
-- 
-- ============================================================================