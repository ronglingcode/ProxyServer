const url = require('url')
const express = require('express')
const router = express.Router()
const needle = require('needle')
const fs = require('fs')
const path = require('path')

router.use(express.json())

const axios = require('axios');

function getCurrentTimestamp() {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    return time;
}

function getLogFilename() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const filename = `${year}-${month}-${day}.log`;
    return path.join(__dirname, '..', 'data', filename);
}

// Helper function to print logs with timestamp
function printLog(message) {
    const logMessage = `[${getCurrentTimestamp()}] ${message}`;
    console.log(logMessage);
    try {
        fs.appendFileSync(getLogFilename(), logMessage + '\n');
    } catch (error) {
        console.error('Error writing to log file:', error);
    }
}

function printObjectLog(object) {
    const timestamp = `[${getCurrentTimestamp()}]`;
    console.log(timestamp);
    console.log(object);
    try {
        fs.appendFileSync(getLogFilename(), timestamp + '\n' + JSON.stringify(object, null, 2) + '\n');
    } catch (error) {
        console.error('Error writing to log file:', error);
    }
}

const Trader_API_Host = "https://api.schwabapi.com/trader/v1";
router.get('/userPreference', async (req, res) => {
    let requestUrl = `${Trader_API_Host}/userPreference`;
    try {
        let token = req.header('Authorization');
        let a = await needle('get', requestUrl, {
            headers: {
                'Authorization': token,
            }
        })
        let data = a.body;
        res.status(200).json(data)
    } catch (error) {
        console.error("Error fetching user preference:", error);
        res.status(500).json({ error: "Failed to fetch user preference" });
    }
});
router.get('/accounts', async (req, res) => {
    let apiUrl = `${Trader_API_Host}/accounts`;
    try {
        const params = new URLSearchParams({
            ...url.parse(req.url, true).query,
        })
        let requestUrl = `${apiUrl}?${params}`;

        let token = req.header('Authorization');
        let a = await needle('get', requestUrl, {
            headers: {
                'Authorization': token,
            }
        })
        let data = a.body;
        res.status(200).json(data)
    } catch (error) {
        res.status(500).json({ error })
    }
});
router.get('/accounts/:accountid/orders', async (req, res) => {
    try {
        let accountId = req.params.accountid;
        let apiUrl = `${Trader_API_Host}/accounts/${accountId}/orders`;
        const params = new URLSearchParams({
            ...url.parse(req.url, true).query,
        })
        let requestUrl = `${apiUrl}?${params}`;
        let token = req.header('Authorization');
        let a = await needle('get', requestUrl, {
            headers: {
                'Authorization': token,
            }
        })
        let data = a.body;
        res.status(200).json(data)
    } catch (error) {
        res.status(500).json({ error })
    }
});

router.post('/accounts/:accountid/orders', async (req, res) => {
    try {
        printLog('rongling');
        printLog('post order');
        let accountId = req.params.accountid;
        const reqBody = req.body;
        let ordersUrl = `${Trader_API_Host}/accounts/${accountId}/orders`;
        let ordersResponse = await fetch(ordersUrl, {
            method: 'POST',
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "Authorization": req.header("Authorization")
            },
            body: JSON.stringify(reqBody)
        });
        let returnData = {
            orderId: -1,
        }
        let orderLocation = ordersResponse.headers.get('location');
        if (orderLocation) {
            let orderLocationParts = orderLocation.split('/');
            if (orderLocationParts.length > 0) {
                returnData.orderId = orderLocationParts[orderLocationParts.length - 1];
            }
        }
        printObjectLog(returnData);
        res.status(200).json(returnData);
    } catch (error) {
        printLog(`error response`);
        printObjectLog(error);
        res.status(500).json({ error })
    }
});

router.delete('/accounts/:accountid/orders/:orderid', async (req, res) => {
    printLog(`cancel order request`);

    try {
        let accountId = req.params.accountid;
        let orderId = req.params.orderid;
        let requestUrl = `${Trader_API_Host}/accounts/${accountId}/orders/${orderId}`;
        let token = req.header('Authorization');
        let apiResponse = await needle('delete', requestUrl, null, {
            headers: {
                'Authorization': token,
            }
        })
        let data = apiResponse.body;
        printObjectLog(data);
        let statusCode = apiResponse.statusCode;
        if (statusCode == 200) {
            res.status(apiResponse.statusCode).json(apiResponse.body)
        } else {
            res.status(apiResponse.statusCode).send(apiResponse.body)
        }
    } catch (error) {
        res.status(500).json({ error })
    }
});
router.put('/accounts/:accountid/orders/:orderid', async (req, res) => {
    printLog(`replace order request`);

    try {
        let accountId = req.params.accountid;
        let orderId = req.params.orderid;
        const reqBody = req.body;
        printObjectLog(reqBody)
        let requestUrl = `${Trader_API_Host}/accounts/${accountId}/orders/${orderId}`;
        printLog(requestUrl);
        let apiResponse = await fetch(requestUrl, {
            method: 'PUT',
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "Authorization": req.header("Authorization")
            },
            body: JSON.stringify(reqBody)
        });
        let data = await apiResponse.json();
        printObjectLog(data);
        let statusCode = apiResponse.status;
        printLog(statusCode);
        if (statusCode == 200) {
            res.status(statusCode).json(data)
        } else {
            res.status(statusCode).send(data)
        }
    } catch (error) {
        res.status(500).json({ error })
    }
});

router.post('/v1/oauth/token', async (req, res) => {
    try {
        const reqBody = req.body;
        printObjectLog(req.body);
        let authUrl = 'https://api.schwabapi.com/v1/oauth/token';
        let authResponse = await fetch(authUrl, {
            method: 'POST',
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": req.header("Authorization")
            },
            body: new URLSearchParams(reqBody)
        });
        let authJson = await authResponse.json();
        printObjectLog(authJson);
        res.status(200).json(authJson);
    } catch (error) {
        res.status(500).json({ error })
    }
})

module.exports = router