const url = require('url')
const express = require('express')
const router = express.Router()

router.use(express.json())

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