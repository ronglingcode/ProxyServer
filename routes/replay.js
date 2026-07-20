const express = require('express')

module.exports = storage => {
    const router = express.Router()

    const sendError = (res, error) => {
        console.error('[replay]', error)
        res.status(error.statusCode || 400).json({ error: error.message || 'Replay request failed' })
    }

    router.get('/recordings', async (req, res) => {
        try {
            const date = req.query.date ? storage.validateDate(String(req.query.date)) : undefined
            const symbol = req.query.symbol ? storage.validateSymbol(String(req.query.symbol)) : undefined
            res.json({ recordings: await storage.listRecordings({ date, symbol }) })
        } catch (error) {
            sendError(res, error)
        }
    })

    router.post('/recordings', async (req, res) => {
        try {
            const manifest = await storage.createRecording(req.body || {})
            res.status(201).json({
                manifest,
                capturePath: `/replay/recordings/${encodeURIComponent(manifest.recordingId)}/capture`,
            })
        } catch (error) {
            sendError(res, error)
        }
    })

    router.get('/recordings/:id/bootstrap', async (req, res) => {
        try {
            res.json(await storage.getBootstrap(req.params.id))
        } catch (error) {
            sendError(res, error)
        }
    })

    router.put('/recordings/:id/bootstrap', async (req, res) => {
        try {
            res.json({ manifest: await storage.writeBootstrap(req.params.id, req.body) })
        } catch (error) {
            sendError(res, error)
        }
    })

    router.post('/recordings/:id/finalize', async (req, res) => {
        try {
            res.json({ manifest: await storage.finalize(req.params.id, req.body || {}) })
        } catch (error) {
            sendError(res, error)
        }
    })

    router.get('/recordings/:id', async (req, res) => {
        try {
            res.json({ manifest: await storage.getManifest(req.params.id) })
        } catch (error) {
            sendError(res, error)
        }
    })

    return router
}
