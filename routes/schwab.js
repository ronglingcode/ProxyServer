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