const url = require('url')
const express = require('express')
const router = express.Router()

router.use(express.json())

router.post('/oauth/token', async (req, res) => {
    try {
        const reqBody = req.body;
        console.log(req.body);
        let authUrl = 'https://signin.tradestation.com/oauth/token';
        let authResponse = await fetch(authUrl, {
            method: 'POST',
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
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