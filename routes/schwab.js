const url = require('url')
const express = require('express')
const router = express.Router()
const needle = require('needle')

router.use(express.json())

const axios = require('axios');



const Trader_API_Host = "https://api.schwabapi.com/trader/v1";
router.get('/accounts', async (req, res) => {
    console.log(`request`);
    let apiUrl = `${Trader_API_Host}/accounts`;
    try {
        const params = new URLSearchParams({
            ...url.parse(req.url, true).query,
        })
        let requestUrl = `${apiUrl}?${params}`;
        console.log(`send request to ${requestUrl}`);

        let token = req.header('Authorization');
        let a = await needle('get', requestUrl, {
            headers: {
                'Authorization': token,
            }
        })
        let data = a.body;
        console.log(`send with ${token}`)
        res.status(200).json(data)
    } catch (error) {
        res.status(500).json({ error })
    }
});
router.get('/accounts/:accountid/orders', async (req, res) => {
    console.log(`request`);

    try {
        let accountId = req.params.accountid;
        let apiUrl = `${Trader_API_Host}/accounts/${accountId}/orders`;
        const params = new URLSearchParams({
            ...url.parse(req.url, true).query,
        })
        let requestUrl = `${apiUrl}?${params}`;
        console.log(`send request to ${requestUrl}`);

        let token = req.header('Authorization');
        let a = await needle('get', requestUrl, {
            headers: {
                'Authorization': token,
            }
        })
        let data = a.body;
        console.log(`send with ${token}`)
        res.status(200).json(data)
    } catch (error) {
        res.status(500).json({ error })
    }
});

router.post('/accounts/:accountid/orders', async (req, res) => {
    try {
        let accountId = req.params.accountid;

        const reqBody = req.body;

        let overrideBody = {
            "orderType": "LIMIT", "session": "NORMAL", "duration": "DAY", "orderStrategyType": "SINGLE", "price": '10.00',
            "orderLegCollection": [
                { "instruction": "BUY", "quantity": 1, "instrument": { "symbol": "INTC", "assetType": "EQUITY" } }]
        };
        let ordersUrl = `${Trader_API_Host}/accounts/${accountId}/orders`;
        let ordersResponse = await fetch(ordersUrl, {
            method: 'POST',
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "Authorization": req.header("Authorization")
            },
            body: JSON.stringify(overrideBody)
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
        console.log(returnData);
        res.status(200).json(returnData);
    } catch (error) {
        console.log(`error response`);
        console.log(error);
        res.status(500).json({ error })
    }
});

router.delete('/accounts/:accountid/orders/:orderid', async (req, res) => {
    console.log(`cancel order request`);

    try {
        let accountId = req.params.accountid;
        let orderId = req.params.orderid;
        let requestUrl = `${Trader_API_Host}/accounts/${accountId}/orders/${orderId}`;
        let token = req.header('Authorization');
        let apiResponse = await needle('delete', requestUrl, {
            headers: {
                'Authorization': token,
            }
        })
        let data = apiResponse.body;
        console.log(data);
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

router.post('/v1/oauth/token', async (req, res) => {
    try {
        const reqBody = req.body;
        console.log(req.body);
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
        console.log(authJson);
        res.status(200).json(authJson);
    } catch (error) {
        res.status(500).json({ error })
    }
})

module.exports = router