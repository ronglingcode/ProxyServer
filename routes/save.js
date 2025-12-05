const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');

// Helper function to get today's date in YYYY-MM-DD format
const getTodayDate = () => {
    const today = new Date();
    return today.toISOString().split('T')[0];
};

// Helper function to ensure directory exists
const ensureDirectoryExists = async (dirPath) => {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
};

// Helper function to append data to file
const appendToFile = async (filepath, textline) => {
    try {
        // Convert data to a single line string
        const dataLine = textline + '\n';
        await fs.appendFile(filepath, dataLine);
        return true;
    } catch (error) {
        console.error(`Error appending to file ${filepath}:`, error);
        throw error;
    }
};

// POST endpoint for level 1 quotes
router.post('/level1quote', async (req, res) => {
    try {
        const {
            symbol,
            bidPrice,
            bidSize,
            askPrice,
            askSize,
            millisecondsSinceMarketOpen,
        } = req.body;

        // Validate required fields
        if (!symbol || bidPrice === undefined || bidSize === undefined ||
            askPrice === undefined || askSize === undefined ||
            millisecondsSinceMarketOpen === undefined) {
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['symbol', 'bidPrice', 'bidSize', 'askPrice', 'askSize', 'millisecondsSinceMarketopen']
            });
        }
        // Create data directory if it doesn't exist
        const dataDir = path.join(__dirname, '..', 'data', 'level1quotes');
        await ensureDirectoryExists(dataDir);

        // Generate filename using date and symbol
        const filename = `${getTodayDate()}_level1quote_${symbol.toUpperCase()}.txt`;
        const filepath = path.join(dataDir, filename);

        // Append data to file
        await appendToFile(filepath, `${bidPrice},${bidSize},${askPrice},${askSize},${millisecondsSinceMarketOpen}`);

        res.status(200).json({
            message: 'Level 1 quote saved successfully',
            symbol: symbol,
            filename: filename
        });
    } catch (error) {
        console.error('Error saving level 1 quote:', error);
        res.status(500).json({
            error: 'Failed to save level 1 quote',
            message: error.message
        });
    }
});

// POST endpoint for time and sales data
router.post('/timeandsales', async (req, res) => {
    try {
        const {
            symbol,
            price,
            quantity,
            millisecondsSinceMarketOpen
        } = req.body;

        // Validate required fields
        if (!symbol || price === undefined || quantity === undefined ||
            millisecondsSinceMarketOpen === undefined) {
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['symbol', 'price', 'quantity', 'millisecondsSinceMarketOpen']
            });
        }

        // Create data directory if it doesn't exist
        const dataDir = path.join(__dirname, '..', 'data', 'timeandsales');
        await ensureDirectoryExists(dataDir);

        // Generate filename using date and symbol
        const filename = `${getTodayDate()}_timeandsales_${symbol.toUpperCase()}.txt`;
        const filepath = path.join(dataDir, filename);

        // Append data to file
        await appendToFile(filepath, `${price},${quantity},${millisecondsSinceMarketOpen}`);

        res.status(200).json({
            message: 'Time and sales data saved successfully',
            symbol: symbol,
            filename: filename
        });
    } catch (error) {
        console.error('Error saving time and sales data:', error);
        res.status(500).json({
            error: 'Failed to save time and sales data',
            message: error.message
        });
    }
});


// POST endpoint for agent response 
router.post('/agentresponse', async (req, res) => {
    try {
        const {
            symbol,
            response,
        } = req.body;
        // Validate required fields
        if (!symbol || response === undefined) {
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['symbol', 'response']
            });
        }

        let currentTime = new Date();
        let currentTimeString = currentTime.toTimeString().split(' ')[0]; // "HH:MM:SS"

        // Create data directory if it doesn't exist
        const dataDir = path.join(__dirname, '..', 'data', 'agentresponse');
        await ensureDirectoryExists(dataDir);

        // Generate filename using date and symbol
        const filename = `${getTodayDate()}_${symbol.toUpperCase()}.txt`;
        const filepath = path.join(dataDir, filename);

        // Append data to file
        await appendToFile(filepath, `${currentTimeString}\n${response}`);

        res.status(200).json({
            message: 'Agent response saved successfully',
            symbol: symbol,
            filename: filename
        });
    } catch (error) {
        console.error('Error saving agent response:', error);
        res.status(500).json({ error });
    }
});
module.exports = router;
