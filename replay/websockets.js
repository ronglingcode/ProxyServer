const { WebSocketServer, WebSocket } = require('ws')

const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024

class PlaybackSession {
    constructor(storage, socket, recordingId, requestedSpeed) {
        this.storage = storage
        this.socket = socket
        this.recordingId = recordingId
        this.speed = this.parseSpeed(requestedSpeed)
        this.paused = false
        this.stopped = false
        this.timer = null
        this.iterator = null
        this.pendingEvent = null
        this.timelineOffsetAtAnchor = 0
        this.wallAnchorMs = Date.now()
        this.firstPlayedOffset = null
        this.cutoverEpochMs = 0
    }

    parseSpeed(value) {
        const speed = Number(value)
        return Number.isFinite(speed) && speed >= 0.1 && speed <= 50 ? speed : 1
    }

    send(value) {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(value))
        }
    }

    async start() {
        const manifest = await this.storage.getManifest(this.recordingId)
        this.cutoverEpochMs = manifest.cutoverEpochMs
        this.iterator = this.storage.readEvents(this.recordingId)[Symbol.asyncIterator]()
        this.send({ type: 'replayReady', manifest, speed: this.speed })
        await this.loadNextEvent(manifest.cutoverEpochMs)
        this.schedulePending()
    }

    async loadNextEvent(cutoverEpochMs) {
        while (!this.stopped && this.iterator) {
            const next = await this.iterator.next()
            if (next.done) {
                this.pendingEvent = null
                this.send({ type: 'replayEnded' })
                return
            }
            if (next.value.marketTimeEpochMs < cutoverEpochMs) continue
            this.pendingEvent = next.value
            if (this.firstPlayedOffset === null) {
                this.firstPlayedOffset = this.pendingEvent.arrivalOffsetMs
                this.timelineOffsetAtAnchor = this.firstPlayedOffset
                this.wallAnchorMs = Date.now()
            }
            return
        }
    }

    currentTimelineOffset() {
        if (this.paused) return this.timelineOffsetAtAnchor
        return this.timelineOffsetAtAnchor + (Date.now() - this.wallAnchorMs) * this.speed
    }

    schedulePending() {
        if (this.stopped || this.paused || !this.pendingEvent) return
        clearTimeout(this.timer)
        const delay = Math.max(0, (this.pendingEvent.arrivalOffsetMs - this.currentTimelineOffset()) / this.speed)
        this.timer = setTimeout(() => this.deliverPending().catch(error => this.fail(error)), Math.min(delay, 2147483647))
    }

    async deliverPending() {
        if (this.stopped || this.paused || !this.pendingEvent) return
        if (this.socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
            this.timer = setTimeout(() => this.deliverPending().catch(error => this.fail(error)), 20)
            return
        }
        const deliveryLagMs = Math.max(0, (this.currentTimelineOffset() - this.pendingEvent.arrivalOffsetMs) / this.speed)
        this.send({ type: 'replayEvent', event: this.pendingEvent, deliveryLagMs })
        await this.loadNextEvent(this.cutoverEpochMs)
        this.schedulePending()
    }

    pause() {
        if (this.paused) return
        this.timelineOffsetAtAnchor = this.currentTimelineOffset()
        this.wallAnchorMs = Date.now()
        this.paused = true
        clearTimeout(this.timer)
        this.send({ type: 'replayStatus', status: 'paused', speed: this.speed })
    }

    play() {
        if (!this.paused) return
        this.wallAnchorMs = Date.now()
        this.paused = false
        this.send({ type: 'replayStatus', status: 'playing', speed: this.speed })
        this.schedulePending()
    }

    setSpeed(value) {
        const nextSpeed = this.parseSpeed(value)
        this.timelineOffsetAtAnchor = this.currentTimelineOffset()
        this.wallAnchorMs = Date.now()
        this.speed = nextSpeed
        this.send({ type: 'replayStatus', status: this.paused ? 'paused' : 'playing', speed: this.speed })
        this.schedulePending()
    }

    handleCommand(raw) {
        let command
        try {
            command = JSON.parse(String(raw))
        } catch {
            return
        }
        if (command.type === 'pause') this.pause()
        if (command.type === 'play') this.play()
        if (command.type === 'speed') this.setSpeed(command.speed)
    }

    fail(error) {
        this.send({ type: 'replayError', message: error.message })
        this.stop()
    }

    stop() {
        this.stopped = true
        clearTimeout(this.timer)
        this.iterator?.return?.()
    }
}

const handleCapture = (storage, socket, recordingId) => {
    let captureOpened = false
    let captureOpenError = null
    let finalized = false
    const send = value => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(value))
        }
    }
    let queue = storage.openCapture(recordingId).then(() => {
        captureOpened = true
    }).catch(error => {
        captureOpenError = error
        send({ type: 'captureError', message: error.message })
        socket.close()
    })
    socket.on('message', raw => {
        queue = queue.then(async () => {
            if (captureOpenError) throw captureOpenError
            const message = JSON.parse(String(raw))
            if (message.type === 'events') {
                const manifest = await storage.appendEvents(recordingId, message.events)
                send({ type: 'captureAck', lastSequence: manifest?.lastSequence ?? -1 })
            } else if (message.type === 'finalize') {
                await storage.finalize(recordingId, {
                    complete: true,
                    droppedCaptureBatchCount: message.droppedCaptureBatchCount,
                })
                finalized = true
                send({ type: 'captureFinalized' })
            }
        }).catch(error => {
            send({ type: 'captureError', message: error.message })
        })
    })
    socket.on('close', () => {
        queue.then(() => {
            if (!captureOpened) return
            if (!finalized) return storage.finalize(recordingId, { complete: false })
        }).catch(error => console.error(`Failed to close capture ${recordingId}:`, error.message))
            .finally(() => {
                if (captureOpened) storage.closeCapture(recordingId)
            })
    })
}

const attachReplayWebSockets = (server, storage) => {
    const webSocketServer = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
        const requestUrl = new URL(request.url, 'http://localhost')
        const match = requestUrl.pathname.match(/^\/replay\/recordings\/([^/]+)\/(capture|play)$/)
        if (!match) {
            socket.destroy()
            return
        }
        let recordingId
        try {
            recordingId = storage.validateId(decodeURIComponent(match[1]))
        } catch {
            socket.destroy()
            return
        }
        webSocketServer.handleUpgrade(request, socket, head, webSocket => {
            if (match[2] === 'capture') {
                handleCapture(storage, webSocket, recordingId)
                return
            }
            const playback = new PlaybackSession(storage, webSocket, recordingId, requestUrl.searchParams.get('speed'))
            webSocket.on('message', raw => playback.handleCommand(raw))
            webSocket.on('close', () => playback.stop())
            playback.start().catch(error => playback.fail(error))
        })
    })
    return webSocketServer
}

module.exports = { attachReplayWebSockets, PlaybackSession }
