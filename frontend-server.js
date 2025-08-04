const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const { ethers } = require('ethers');
const { Pool } = require('pg');
const fs = require('fs');

dotenv.config();

const app = express();
const PORT = process.env.LOCAL_FRONTEND_PORT || 3001; // Use a different port than the main backend

// Database connection setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Railway's PostgreSQL
    }
});

// Ethereum RPC Provider setup
const provider = new ethers.JsonRpcProvider(process.env.RPC_HTTP_URL);

// Smart Contract setup
const contractAddress = process.env.CONTRACT_ADDRESS;
const contractABI = JSON.parse(fs.readFileSync('./abi.json', 'utf8'));
const contract = new ethers.Contract(contractAddress, contractABI, provider);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint to get latest epoch and lock time from smart contract
app.get('/api/round-info', async (req, res) => {
    try {
        const currentEpoch = await contract.currentEpoch();
        const roundData = await contract.rounds(currentEpoch);
        const lockTime = roundData.lockTimestamp.toNumber() * 1000; // Convert to milliseconds

        res.json({
            epoch: currentEpoch.toString(),
            lockTime: lockTime
        });
    } catch (error) {
        console.error('Error fetching round info from contract:', error);
        res.status(500).json({ error: 'Failed to fetch round info' });
    }
});

// API endpoint to get latest bet data from database
app.get('/api/latest-bets', async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT * FROM realbet ORDER BY bet_ts DESC LIMIT 100'); // Get latest 100 bets
        client.release();
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching latest bets from database:', error);
        res.status(500).json({ error: 'Failed to fetch latest bets' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Local frontend server running on http://localhost:${PORT}`);
});

console.log('Local frontend server setup complete.');
