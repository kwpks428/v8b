const DatabaseV4 = require('./database');

class ClaimsAnalyzer {
    constructor() {
        this.db = new DatabaseV4();
        this.suspiciousWallets = new Set();
        this.analysisResults = new Map();
    }

    async initialize() {
        await this.db.initialize();
        console.log('✅ Claims分析器初始化完成');
    }

    // 🔍 分析claims表，找出同一局內領取多個回合獎金的錢包
    async analyzeSuspiciousClaims() {
        try {
            console.log('🔍 開始分析claims表中的可疑領獎行為...');

            // 查詢所有claims記錄，按局次和錢包分組
            const query = `
                SELECT 
                    epoch,
                    wallet_address,
                    COUNT(*) as claim_count,
                    ARRAY_AGG(DISTINCT bet_epoch) as bet_epochs,
                    ARRAY_AGG(claim_amount) as claim_amounts,
                    ARRAY_AGG(claim_ts) as claim_times,
                    ARRAY_AGG(tx_hash) as tx_hashes,
                    SUM(claim_amount) as total_claimed
                FROM claims 
                GROUP BY epoch, wallet_address
                HAVING COUNT(*) > 1
                ORDER BY epoch DESC, total_claimed DESC
            `;

            const result = await this.db.pool.query(query);
            console.log(`📊 找到 ${result.rows.length} 個可疑的多重領獎記錄`);

            const suspiciousData = [];

            for (const row of result.rows) {
                const suspiciousInfo = {
                    epoch: row.epoch,
                    wallet_address: row.wallet_address,
                    claim_count: parseInt(row.claim_count),
                    bet_epochs: row.bet_epochs,
                    claim_amounts: row.claim_amounts.map(amount => parseFloat(amount)),
                    claim_times: row.claim_times.map(time => this.db.formatTimestamp(time)),
                    tx_hashes: row.tx_hashes,
                    total_claimed: parseFloat(row.total_claimed),
                    risk_level: this.calculateRiskLevel(parseInt(row.claim_count), parseFloat(row.total_claimed))
                };

                suspiciousData.push(suspiciousInfo);
                this.suspiciousWallets.add(row.wallet_address);

                console.log(`🚨 可疑錢包: ${row.wallet_address}`);
                console.log(`   局次: ${row.epoch}, 領獎次數: ${row.claim_count}`);
                console.log(`   領獎回合: ${row.bet_epochs.join(', ')}`);
                console.log(`   總領獎金額: ${parseFloat(row.total_claimed).toFixed(4)} BNB`);
                console.log(`   風險等級: ${suspiciousInfo.risk_level}`);
                console.log('---');
            }

            // 存儲分析結果
            this.analysisResults.set('suspicious_claims', suspiciousData);

            return {
                total_suspicious_wallets: this.suspiciousWallets.size,
                suspicious_records: suspiciousData.length,
                data: suspiciousData
            };

        } catch (error) {
            console.error('❌ 分析claims表失敗:', error);
            throw error;
        }
    }

    // 📊 計算風險等級
    calculateRiskLevel(claimCount, totalAmount) {
        if (claimCount >= 5 || totalAmount >= 5.0) {
            return 'HIGH'; // 高風險：領獎5次以上或總金額超過5 BNB
        } else if (claimCount >= 3 || totalAmount >= 1.0) {
            return 'MEDIUM'; // 中風險：領獎3次以上或總金額超過1 BNB
        } else {
            return 'LOW'; // 低風險：其他情況
        }
    }

    // 🎯 檢查特定錢包是否為可疑錢包
    isSuspiciousWallet(walletAddress) {
        return this.suspiciousWallets.has(walletAddress);
    }

    // 📈 獲取可疑錢包的詳細信息
    getSuspiciousWalletDetails(walletAddress) {
        const suspiciousData = this.analysisResults.get('suspicious_claims') || [];
        return suspiciousData.filter(record => record.wallet_address === walletAddress);
    }

    // 🔍 分析特定局次的可疑活動
    async analyzeEpochSuspiciousActivity(epoch) {
        try {
            const query = `
                SELECT 
                    wallet_address,
                    COUNT(*) as claim_count,
                    ARRAY_AGG(DISTINCT bet_epoch) as bet_epochs,
                    ARRAY_AGG(claim_amount) as claim_amounts,
                    SUM(claim_amount) as total_claimed
                FROM claims 
                WHERE epoch = $1
                GROUP BY wallet_address
                HAVING COUNT(*) > 1
                ORDER BY total_claimed DESC
            `;

            const result = await this.db.pool.query(query, [epoch]);
            
            return result.rows.map(row => ({
                wallet_address: row.wallet_address,
                claim_count: parseInt(row.claim_count),
                bet_epochs: row.bet_epochs,
                claim_amounts: row.claim_amounts.map(amount => parseFloat(amount)),
                total_claimed: parseFloat(row.total_claimed)
            }));

        } catch (error) {
            console.error(`❌ 分析局次 ${epoch} 失敗:`, error);
            return [];
        }
    }

    // 📊 生成統計報告
    generateSuspiciousClaimsReport() {
        const suspiciousData = this.analysisResults.get('suspicious_claims') || [];
        
        if (suspiciousData.length === 0) {
            return {
                summary: '沒有發現可疑的多重領獎行為',
                total_wallets: 0,
                total_records: 0,
                risk_distribution: {HIGH: 0, MEDIUM: 0, LOW: 0}
            };
        }

        // 按風險等級統計
        const riskStats = {
            HIGH: suspiciousData.filter(d => d.risk_level === 'HIGH').length,
            MEDIUM: suspiciousData.filter(d => d.risk_level === 'MEDIUM').length,
            LOW: suspiciousData.filter(d => d.risk_level === 'LOW').length
        };

        // 統計最大領獎次數和金額
        const maxClaimCount = Math.max(...suspiciousData.map(d => d.claim_count));
        const maxTotalClaimed = Math.max(...suspiciousData.map(d => d.total_claimed));

        // 找出最可疑的錢包
        const topSuspiciousWallet = suspiciousData.reduce((max, current) => 
            current.total_claimed > max.total_claimed ? current : max
        );

        return {
            summary: `發現 ${this.suspiciousWallets.size} 個可疑錢包，共 ${suspiciousData.length} 筆可疑記錄`,
            total_wallets: this.suspiciousWallets.size,
            total_records: suspiciousData.length,
            risk_distribution: riskStats,
            max_claim_count: maxClaimCount,
            max_total_claimed: maxTotalClaimed.toFixed(4),
            top_suspicious_wallet: {
                address: topSuspiciousWallet.wallet_address,
                total_claimed: topSuspiciousWallet.total_claimed.toFixed(4),
                risk_level: topSuspiciousWallet.risk_level
            },
            suspicious_wallets: Array.from(this.suspiciousWallets)
        };
    }

    // 💾 保存分析結果到文件
    async saveAnalysisResults() {
        const fs = require('fs').promises;
        const report = this.generateSuspiciousClaimsReport();
        const suspiciousData = this.analysisResults.get('suspicious_claims') || [];

        const analysisReport = {
            generated_at: new Date().toISOString(),
            summary: report,
            detailed_records: suspiciousData
        };

        try {
            await fs.writeFile(
                'suspicious-claims-analysis.json', 
                JSON.stringify(analysisReport, null, 2)
            );
            console.log('📄 分析結果已保存到 suspicious-claims-analysis.json');
        } catch (error) {
            console.error('❌ 保存分析結果失敗:', error);
        }
    }

    // 🔄 定期更新可疑錢包列表
    async updateSuspiciousWalletsList() {
        try {
            const analysis = await this.analyzeSuspiciousClaims();
            const report = this.generateSuspiciousClaimsReport();
            
            console.log('🔄 可疑錢包列表已更新');
            console.log(`📊 ${report.summary}`);
            
            return {
                success: true,
                suspicious_wallets: Array.from(this.suspiciousWallets),
                analysis_summary: report
            };
        } catch (error) {
            console.error('❌ 更新可疑錢包列表失敗:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async close() {
        await this.db.close();
        console.log('✅ Claims分析器已關閉');
    }
}

// 如果直接運行此文件
if (require.main === module) {
    const analyzer = new ClaimsAnalyzer();
    
    async function runAnalysis() {
        try {
            await analyzer.initialize();
            
            console.log('🚀 開始執行claims分析...');
            const analysis = await analyzer.analyzeSuspiciousClaims();
            
            console.log('\n📊 分析結果摘要:');
            const report = analyzer.generateSuspiciousClaimsReport();
            console.log(JSON.stringify(report, null, 2));
            
            console.log('\n💾 保存分析結果...');
            await analyzer.saveAnalysisResults();
            
        } catch (error) {
            console.error('❌ 分析執行失敗:', error);
        } finally {
            await analyzer.close();
        }
    }
    
    runAnalysis();
}

module.exports = ClaimsAnalyzer;