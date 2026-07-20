const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs').promises
const { ReplayStorage } = require('../replay/storage')
const http = require('http')
const { WebSocket } = require('ws')
const { attachReplayWebSockets } = require('../replay/websockets')

const buildBootstrap = manifest => ({
    symbol: manifest.symbol,
    marketDate: manifest.marketDate,
    cutoverEpochMs: manifest.cutoverEpochMs,
    today1MinuteBars: [{
        symbol: manifest.symbol,
        time: Math.floor((manifest.cutoverEpochMs - 60_000) / 1000),
        open: 10,
        high: 11,
        low: 9,
        close: 10.5,
        volume: 1000,
        datetime: manifest.cutoverEpochMs - 60_000,
        vwap: 10.25,
    }],
    dailyBars: [],
    premarketDollarCollection: {},
    sharesOutstanding: 1000000,
    runtimeSnapshot: {},
})

const buildEvent = (sequence, marketTimeEpochMs) => ({
    sequence,
    arrivalOffsetMs: sequence * 100,
    marketTimeEpochMs,
    message: {
        type: 'timeSaleFlush',
        source: 'm',
        trades: [{
            shouldFilter: false,
            record: {
                symbol: 'TSLA',
                timestamp: marketTimeEpochMs,
                tradeTime: marketTimeEpochMs,
                receivedTime: marketTimeEpochMs,
                lastPrice: 10,
                lastSize: 100,
                conditions: [],
            },
        }],
    },
})

test('records, lists, reads, and finalizes a complete replay', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-replay-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const storage = new ReplayStorage({ root, chunkBytes: 300 })
    const cutoverEpochMs = Date.now() + 60_000
    const marketOpenEpochMs = cutoverEpochMs - 2 * 60 * 60 * 1000
    const manifest = await storage.createRecording({
        marketDate: '2026-07-17',
        symbol: 'tsla',
        cutoverEpochMs,
        marketOpenEpochMs,
        captureStartedAtEpochMs: cutoverEpochMs - 1000,
    })
    assert.equal(manifest.marketOpenEpochMs, marketOpenEpochMs)
    await storage.writeBootstrap(manifest.recordingId, buildBootstrap(manifest))
    await storage.appendEvents(manifest.recordingId, [
        buildEvent(0, cutoverEpochMs),
        buildEvent(1, cutoverEpochMs + 100),
    ])
    const finalized = await storage.finalize(manifest.recordingId, { complete: true })
    assert.equal(finalized.status, 'complete')
    assert.equal(finalized.eventCount, 2)
    assert.equal(finalized.tradeRecordCount, 2)

    const listed = await storage.listRecordings({ symbol: 'TSLA' })
    assert.equal(listed.length, 1)
    const events = []
    for await (const event of storage.readEvents(manifest.recordingId)) events.push(event)
    assert.deepEqual(events.map(event => event.sequence), [0, 1])
})

test('sequence gaps make a recording incomplete', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-replay-gap-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const storage = new ReplayStorage({ root })
    const cutoverEpochMs = Date.now() + 60_000
    const manifest = await storage.createRecording({
        marketDate: '2026-07-17',
        symbol: 'TSLA',
        cutoverEpochMs,
        captureStartedAtEpochMs: cutoverEpochMs - 1000,
    })
    await storage.writeBootstrap(manifest.recordingId, buildBootstrap(manifest))
    await storage.appendEvents(manifest.recordingId, [buildEvent(1, cutoverEpochMs)])
    const finalized = await storage.finalize(manifest.recordingId, { complete: true })
    assert.equal(finalized.status, 'incomplete')
    assert.equal(finalized.gaps.length, 1)
})

test('rejects a bootstrap candle that overlaps replay events', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-replay-overlap-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const storage = new ReplayStorage({ root })
    const cutoverEpochMs = Date.now() + 60_000
    const manifest = await storage.createRecording({ marketDate: '2026-07-17', symbol: 'TSLA', cutoverEpochMs })
    const bootstrap = buildBootstrap(manifest)
    bootstrap.today1MinuteBars[0].datetime = cutoverEpochMs
    await assert.rejects(storage.writeBootstrap(manifest.recordingId, bootstrap), /at or after/)
    const mismatchedCutover = buildBootstrap(manifest)
    mismatchedCutover.cutoverEpochMs++
    await assert.rejects(storage.writeBootstrap(manifest.recordingId, mismatchedCutover), /cutover does not match/)
})

test('rejects unsafe recording metadata and ids', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-replay-validation-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const storage = new ReplayStorage({ root })
    await assert.rejects(storage.createRecording({
        marketDate: '../2026-07-17',
        symbol: 'TSLA',
        cutoverEpochMs: Date.now(),
    }), /YYYY-MM-DD/)
    await assert.rejects(storage.createRecording({
        marketDate: '2026-07-17',
        symbol: '../../TSLA',
        cutoverEpochMs: Date.now(),
    }), /invalid symbol/)
    assert.throws(() => storage.validateId('../manifest.json'), /invalid recording id/)
})

test('ignores a malformed trailing JSONL line during recovery', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-replay-recovery-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const storage = new ReplayStorage({ root })
    const cutoverEpochMs = Date.now() + 60_000
    const manifest = await storage.createRecording({
        marketDate: '2026-07-17',
        symbol: 'TSLA',
        cutoverEpochMs,
        captureStartedAtEpochMs: cutoverEpochMs - 1000,
    })
    await storage.writeBootstrap(manifest.recordingId, buildBootstrap(manifest))
    await storage.appendEvents(manifest.recordingId, [buildEvent(0, cutoverEpochMs)])
    await storage.finalize(manifest.recordingId, { complete: false })
    const recordingDir = await storage.findRecordingDir(manifest.recordingId)
    await fs.appendFile(path.join(recordingDir, 'events-00000.jsonl'), '{"sequence":')

    const recovered = []
    for await (const event of storage.readEvents(manifest.recordingId)) recovered.push(event)
    assert.deepEqual(recovered.map(event => event.sequence), [0])
})

test('marks abandoned recordings incomplete but preserves active capture sessions', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-replay-abandoned-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const storage = new ReplayStorage({ root })
    const makeOldRecording = async symbol => {
        const manifest = await storage.createRecording({
            marketDate: '2026-07-17',
            symbol,
            cutoverEpochMs: Date.now() + 60_000,
        })
        manifest.createdAtEpochMs = Date.now() - 60_000
        const recordingDir = await storage.findRecordingDir(manifest.recordingId)
        await storage.writeManifest(recordingDir, manifest)
        return manifest
    }

    const abandoned = await makeOldRecording('TSLA')
    const active = await makeOldRecording('AAPL')
    await storage.openCapture(active.recordingId)
    const listed = await storage.listRecordings()
    assert.equal(listed.find(item => item.recordingId === abandoned.recordingId).status, 'incomplete')
    assert.equal(listed.find(item => item.recordingId === active.recordingId).status, 'recording')
    storage.closeCapture(active.recordingId)
})

test('capture and playback WebSockets preserve stored event order', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-replay-ws-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const storage = new ReplayStorage({ root })
    const cutoverEpochMs = Date.now() + 60_000
    const manifest = await storage.createRecording({
        marketDate: '2026-07-17',
        symbol: 'TSLA',
        cutoverEpochMs,
        captureStartedAtEpochMs: cutoverEpochMs - 1000,
    })
    await storage.writeBootstrap(manifest.recordingId, buildBootstrap(manifest))

    const server = http.createServer()
    const webSocketServer = attachReplayWebSockets(server, storage)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(async () => {
        webSocketServer.close()
        await new Promise(resolve => server.close(resolve))
    })
    const port = server.address().port

    const capture = new WebSocket(`ws://127.0.0.1:${port}/replay/recordings/${manifest.recordingId}/capture`)
    await new Promise((resolve, reject) => {
        capture.once('open', resolve)
        capture.once('error', reject)
    })
    capture.send(JSON.stringify({
        type: 'events',
        events: [buildEvent(0, cutoverEpochMs), buildEvent(1, cutoverEpochMs + 100)],
    }))
    await new Promise((resolve, reject) => {
        const onMessage = raw => {
            const message = JSON.parse(String(raw))
            if (message.type === 'captureAck') {
                capture.off('error', reject)
                resolve()
            }
        }
        capture.on('message', onMessage)
        capture.once('error', reject)
    })
    capture.send(JSON.stringify({ type: 'finalize' }))
    await new Promise((resolve, reject) => {
        capture.on('message', raw => {
            if (JSON.parse(String(raw)).type === 'captureFinalized') resolve()
        })
        capture.once('error', reject)
    })
    capture.close()

    const playedSequences = []
    const playback = new WebSocket(`ws://127.0.0.1:${port}/replay/recordings/${manifest.recordingId}/play?speed=50`)
    await new Promise((resolve, reject) => {
        playback.on('message', raw => {
            const message = JSON.parse(String(raw))
            if (message.type === 'replayEvent') playedSequences.push(message.event.sequence)
            if (message.type === 'replayEnded') resolve()
        })
        playback.once('error', reject)
    })
    assert.deepEqual(playedSequences, [0, 1])
    playback.close()
})
