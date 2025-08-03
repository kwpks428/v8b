const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const ConnectionManager = require('./db/ConnectionManager');
const HistoricalCrawler = require('./workers/historical-crawler');
const RealtimeListener = require('./workers/realtime-listener');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, '../public')));

async function startServer() {
    try {
        console.log('🚀 Starting application...');

        // Initialize services
        const historicalCrawler = new HistoricalCrawler();
        const realtimeListener = new RealtimeListener();

        await historicalCrawler.initialize();
        await realtimeListener.initialize();

        // Start background workers
        historicalCrawler.start();
        // Realtime listener is already started by its initialize method

        // API endpoint for status
        app.get('/api/status', (req, res) => {
            res.json({
                historicalCrawler: historicalCrawler.getStats(),
                realtimeListener: realtimeListener.getStatus(),
                connectionManager: ConnectionManager.getConnectionStats()
            });
        });

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Web server is running on port ${PORT}`)
            console.log('✨ Application started successfully!');
        });

    } catch (error) {
        console.error('❌ Failed to start application:', error);
        process.exit(1);
    }
}

startServer();
