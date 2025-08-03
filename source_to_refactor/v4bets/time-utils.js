const moment = require('moment-timezone');

/**
 * 統一的時間格式化工具模組
 * 用於database.js, realtime-listener.js, unified-crawler.js
 */
class TimeUtils {
    /**
     * 格式化時間戳為台北時間 (YYYY-MM-DD HH:mm:ss)
     * @param {Date|number|string} timestamp - 時間戳
     * @returns {string} 格式化後的時間字符串
     */
    static formatTimestamp(timestamp) {
        if (!timestamp) return null;
        
        // 處理 Unix 時間戳 (數字)
        if (typeof timestamp === 'number') {
            return moment.unix(timestamp).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss');
        }
        
        // 處理 Date 對象或其他格式
        return moment(timestamp).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss');
    }

    /**
     * 創建台北時間的時間戳
     * @param {Date} date - 輸入日期，默認為當前時間
     * @returns {Date} 台北時區的Date對象
     */
    static createTaipeiTimestamp(date = new Date()) {
        return moment(date).tz('Asia/Taipei').toDate();
    }

    /**
     * 獲取當前台北時間的格式化字符串
     * @returns {string} 當前台北時間 (YYYY-MM-DD HH:mm:ss)
     */
    static getCurrentTaipeiTime() {
        return moment().tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss');
    }

    /**
     * Unix時間戳格式化 (用於unified-crawler.js)
     * @param {number} unixTimestamp - Unix時間戳
     * @returns {string} 格式化後的時間字符串
     */
    static formatUnixTimestamp(unixTimestamp) {
        return moment.unix(unixTimestamp).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss');
    }
}

module.exports = TimeUtils;