class TimeService {
    static get STANDARD_FORMAT() {
        return 'YYYY-MM-DD HH:mm:ss';
    }

    static get TIMEZONE_OFFSET() {
        return 8 * 60; // Taipei Time UTC+8 in minutes
    }

    static formatTaipeiTime(input) {
        if (!input && input !== 0) {
            throw new Error('TimeService: Input cannot be null or undefined');
        }

        try {
            let date;
            if (typeof input === 'number') {
                date = input > 1e10 ? new Date(input) : new Date(input * 1000);
            } else if (input instanceof Date) {
                date = new Date(input);
            } else {
                date = new Date(input);
            }

            if (isNaN(date.getTime())) {
                throw new Error(`Invalid time format: ${input}`);
            }

            const taipeiTime = new Date(date.getTime() + (8 * 60 * 60 * 1000));

            const year = taipeiTime.getUTCFullYear();
            const month = String(taipeiTime.getUTCMonth() + 1).padStart(2, '0');
            const day = String(taipeiTime.getUTCDate()).padStart(2, '0');
            const hour = String(taipeiTime.getUTCHours()).padStart(2, '0');
            const minute = String(taipeiTime.getUTCMinutes()).padStart(2, '0');
            const second = String(taipeiTime.getUTCSeconds()).padStart(2, '0');

            const result = `${year}-${month}-${day} ${hour}:${minute}:${second}`;

            if (!this.isValidFormat(result)) {
                throw new Error(`Time formatting result is abnormal: ${result}`);
            }

            return result;

        } catch (error) {
            console.error('TimeService formatting failed:', error.message);
            console.error('Input value:', input, 'Type:', typeof input);
            throw new Error(`TimeService formatting failed: ${error.message}`);
        }
    }

    static getCurrentTaipeiTime() {
        return this.formatTaipeiTime(new Date());
    }

    static formatUnixTimestamp(unixTimestamp) {
        if (typeof unixTimestamp !== 'number') {
            throw new Error('Unix timestamp must be a number');
        }
        return this.formatTaipeiTime(unixTimestamp);
    }

    static isValidFormat(timeString) {
        if (typeof timeString !== 'string') {
            return false;
        }
        const regex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
        if (!regex.test(timeString)) {
            return false;
        }
        const parts = timeString.split(' ');
        const datePart = parts[0].split('-');
        const timePart = parts[1].split(':');
        const year = parseInt(datePart[0]);
        const month = parseInt(datePart[1]);
        const day = parseInt(datePart[2]);
        const hour = parseInt(timePart[0]);
        const minute = parseInt(timePart[1]);
        const second = parseInt(timePart[2]);
        if (year < 1970 || year > 9999) return false;
        if (month < 1 || month > 12) return false;
        if (day < 1 || day > 31) return false;
        if (hour < 0 || hour > 23) return false;
        if (minute < 0 || minute > 59) return false;
        if (second < 0 || second > 59) return false;
        const testDate = new Date(year, month - 1, day, hour, minute, second);
        return testDate.getFullYear() === year &&
               testDate.getMonth() === month - 1 &&
               testDate.getDate() === day;
    }
}

module.exports = TimeService;
