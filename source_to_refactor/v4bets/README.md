# V4Bets 數據抓取系統

重構的單工版本數據抓取系統，移除了多工和RPC節點切換功能，專注於穩定高效的數據收集。

## 主要特性

- ✅ 單工模式，簡化架構
- ✅ 使用單一高階付費RPC節點
- ✅ PostgreSQL數據存儲
- ✅ 恢復Claims表抓取功能
- ✅ 完整的rounds、hisbets、claims三張表
- ✅ 移除所有多工和RPC切換相關代碼

## 系統架構

### 文件結構
```
v4bets/
├── database.js          # PostgreSQL數據庫操作
├── task-queue.js        # 簡化的任務隊列系統
├── manager.js           # 單工版本的任務管理器
├── worker.js            # 簡化版本的工作器
├── test.js             # 系統測試文件
├── package.json        # 依賴管理
└── README.md           # 使用說明
```

### 數據庫表結構

#### rounds表
- `epoch` (BIGINT): 回合號碼
- `start_ts`, `lock_ts`, `close_ts` (TIMESTAMP): 各階段時間戳
- `lock_price`, `close_price` (DECIMAL): 鎖定價格和結束價格
- `result` (VARCHAR): 結果 UP/DOWN
- `total_amount`, `up_amount`, `down_amount` (DECIMAL): 各類金額  
- `up_payout`, `down_payout` (DECIMAL): 賠率

#### hisbets表
- `id` (SERIAL): 主鍵
- `epoch` (BIGINT): 回合號碼
- `bet_ts` (TIMESTAMP): 下注時間
- `wallet_address` (VARCHAR): 錢包地址
- `bet_direction` (VARCHAR): 下注方向 UP/DOWN
- `amount` (DECIMAL): 下注金額
- `result` (VARCHAR): 結果 WIN/LOSS
- `tx_hash` (VARCHAR): 交易哈希

#### claims表
- `id` (SERIAL): 主鍵
- `epoch` (BIGINT): 回合號碼
- `claim_ts` (TIMESTAMP): 領獎時間
- `wallet_address` (VARCHAR): 錢包地址
- `claim_amount` (DECIMAL): 領獎金額
- `tx_hash` (VARCHAR): 交易哈希

## 使用方法

### 1. 安裝依賴
```bash
cd v4bets
npm install
```

### 2. 運行測試
```bash
npm test
```

### 3. 啟動系統

#### 方法一：分別啟動
```bash
# 啟動管理器（創建任務）
npm run start:manager

# 在另一個終端啟動工作器（處理任務）
npm run start:worker
```

#### 方法二：直接運行
```bash
# 啟動管理器
node manager.js

# 啟動工作器
node worker.js
```

## 系統配置

### RPC節點
系統使用單一高階付費節點：
```
https://lb.drpc.org/bsc/Ahc3I-33qkfGuwXSahR3XfPDRmd6WZsR8JbErqRhf0fE
```

### PostgreSQL連接
```
postgresql://neondb_owner:npg_vXlY01CQdqTh@ep-billowing-smoke-a13osu4w-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

### 合約地址
```
0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA
```

## 重要變更

相比原系統的主要變更：

1. **移除多工功能**：不再支持多個Worker同時運行
2. **移除RPC切換**：只使用一個高階付費節點，不再有備用節點切換
3. **恢復Claims抓取**：重新支持領獎數據的抓取和存儲
4. **PostgreSQL存儲**：從SQLite改為PostgreSQL，支持更好的併發和擴展
5. **簡化任務隊列**：移除文件鎖，簡化任務管理邏輯

## 監控和日誌

系統會輸出詳細的執行日誌：
- 任務創建和完成狀態
- 數據庫操作結果
- RPC請求狀態
- 錯誤和重試信息

## 故障排除

### 常見問題

1. **數據庫連接失敗**
   - 檢查PostgreSQL連接字符串
   - 確認網絡連接正常

2. **RPC請求失敗**
   - 檢查RPC節點狀態
   - 確認網絡連接

3. **任務處理緩慢**
   - 檢查請求限制設置
   - 監控RPC節點響應時間

### 日誌分析

- `✅` 表示成功操作
- `❌` 表示失敗操作  
- `⚠️` 表示警告信息
- `🔄` 表示重試操作

## 性能調優

系統已針對單工模式進行優化：
- 請求限制：100 requests/second
- 批次大小：50個區塊
- 重試次數：3次
- 任務隊列大小：20個

## 維護建議

1. 定期檢查數據庫空間使用
2. 監控RPC節點響應時間
3. 清理舊的完成任務（系統自動保留最新10個）
4. 定期備份PostgreSQL數據

## 技術支持

如遇問題，請檢查：
1. 系統日誌輸出
2. 數據庫連接狀態
3. RPC節點健康狀況
4. 網絡連接穩定性