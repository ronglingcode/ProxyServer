const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const readline = require('readline')
const { once } = require('events')
const { randomUUID } = require('crypto')

const SCHEMA_VERSION = 1
const DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024
const CAPTURE_CONNECT_GRACE_MS = 30 * 1000
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const SYMBOL_PATTERN = /^[A-Z0-9._-]{1,20}$/
const ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/

const atomicWriteJson = async (filePath, value) => {
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
    await fsp.rename(temporaryPath, filePath)
}

const readJson = async filePath => JSON.parse(await fsp.readFile(filePath, 'utf8'))

const isStoredMessage = message => {
    return message && (message.type === 'timeSaleFlush' || message.type === 'quote')
}

class ReplayStorage {
    constructor(options = {}) {
        this.root = options.root || path.join(__dirname, '..', 'data', 'replay')
        this.chunkBytes = options.chunkBytes || DEFAULT_CHUNK_BYTES
        this.active = new Map()
        this.activeCaptures = new Set()
        this.directoryCache = new Map()
    }

    validateDate(value) {
        if (!DATE_PATTERN.test(value || '')) {
            throw new Error('marketDate must use YYYY-MM-DD')
        }
        return value
    }

    validateSymbol(value) {
        const symbol = String(value || '').toUpperCase()
        if (!SYMBOL_PATTERN.test(symbol)) {
            throw new Error('invalid symbol')
        }
        return symbol
    }

    validateId(value) {
        if (!ID_PATTERN.test(value || '')) {
            throw new Error('invalid recording id')
        }
        return value
    }

    async createRecording(input) {
        const marketDate = this.validateDate(input.marketDate)
        const symbol = this.validateSymbol(input.symbol)
        const cutoverEpochMs = Number(input.cutoverEpochMs)
        if (!Number.isFinite(cutoverEpochMs) || cutoverEpochMs <= 0) {
            throw new Error('invalid cutoverEpochMs')
        }
        const marketOpenEpochMs = Number(input.marketOpenEpochMs) || cutoverEpochMs + 5 * 60 * 1000
        if (!Number.isFinite(marketOpenEpochMs) || marketOpenEpochMs <= 0) {
            throw new Error('invalid marketOpenEpochMs')
        }

        const recordingId = `${marketDate}_${symbol}_${Date.now()}_${randomUUID().slice(0, 8)}`
        const recordingDir = path.join(this.root, marketDate, symbol, recordingId)
        await fsp.mkdir(path.dirname(recordingDir), { recursive: true })
        await fsp.mkdir(recordingDir, { recursive: false })

        const createdAtEpochMs = Date.now()
        const manifest = {
            schemaVersion: SCHEMA_VERSION,
            recordingId,
            marketDate,
            symbol,
            exchangeTimezone: 'America/New_York',
            cutoverEpochMs,
            marketOpenEpochMs,
            source: input.source || 'massive',
            appVersion: input.appVersion || 'unknown',
            createdAtEpochMs,
            captureStartedAtEpochMs: Number(input.captureStartedAtEpochMs) || createdAtEpochMs,
            finalizedAtEpochMs: 0,
            firstMarketEventEpochMs: 0,
            lastMarketEventEpochMs: 0,
            eventCount: 0,
            tradeRecordCount: 0,
            quoteEventCount: 0,
            lastSequence: -1,
            droppedCaptureBatchCount: 0,
            bootstrapAvailable: false,
            status: 'recording',
            gaps: [],
        }
        await atomicWriteJson(path.join(recordingDir, 'manifest.json'), manifest)
        this.directoryCache.set(recordingId, recordingDir)
        return manifest
    }

    async findRecordingDir(recordingId) {
        this.validateId(recordingId)
        const cached = this.directoryCache.get(recordingId)
        if (cached) {
            return cached
        }
        await fsp.mkdir(this.root, { recursive: true })
        const dates = await fsp.readdir(this.root, { withFileTypes: true })
        for (const dateEntry of dates) {
            if (!dateEntry.isDirectory()) continue
            const dateDir = path.join(this.root, dateEntry.name)
            const symbols = await fsp.readdir(dateDir, { withFileTypes: true })
            for (const symbolEntry of symbols) {
                if (!symbolEntry.isDirectory()) continue
                const candidate = path.join(dateDir, symbolEntry.name, recordingId)
                try {
                    const stat = await fsp.stat(candidate)
                    if (stat.isDirectory()) {
                        this.directoryCache.set(recordingId, candidate)
                        return candidate
                    }
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error
                }
            }
        }
        const error = new Error('recording not found')
        error.statusCode = 404
        throw error
    }

    async getManifest(recordingId) {
        const recordingDir = await this.findRecordingDir(recordingId)
        return readJson(path.join(recordingDir, 'manifest.json'))
    }

    async openCapture(recordingId) {
        const manifest = await this.getManifest(recordingId)
        if (manifest.status !== 'recording') {
            throw new Error(`recording is ${manifest.status}`)
        }
        if (this.activeCaptures.has(recordingId)) {
            throw new Error('recording already has an active capture client')
        }
        this.activeCaptures.add(recordingId)
    }

    closeCapture(recordingId) {
        this.activeCaptures.delete(recordingId)
    }

    async writeManifest(recordingDir, manifest) {
        await atomicWriteJson(path.join(recordingDir, 'manifest.json'), manifest)
    }

    async writeBootstrap(recordingId, bootstrap) {
        const recordingDir = await this.findRecordingDir(recordingId)
        const active = this.active.get(recordingId)
        const manifest = active?.manifest || await this.getManifest(recordingId)
        if (!bootstrap || bootstrap.symbol !== manifest.symbol || bootstrap.marketDate !== manifest.marketDate) {
            throw new Error('bootstrap symbol/date does not match recording')
        }
        if (Number(bootstrap.cutoverEpochMs) !== manifest.cutoverEpochMs) {
            throw new Error('bootstrap cutover does not match recording')
        }
        if (!Array.isArray(bootstrap.today1MinuteBars) || bootstrap.today1MinuteBars.length === 0) {
            throw new Error('bootstrap requires historical M1 candles')
        }
        const overlapping = bootstrap.today1MinuteBars.find(candle => {
            return !Number.isFinite(Number(candle.datetime)) || Number(candle.datetime) >= manifest.cutoverEpochMs
        })
        if (overlapping) {
            throw new Error('bootstrap contains a candle at or after the replay cutover')
        }
        if (!Array.isArray(bootstrap.dailyBars)) {
            throw new Error('bootstrap dailyBars must be an array')
        }

        await atomicWriteJson(path.join(recordingDir, 'bootstrap.json'), bootstrap)
        manifest.bootstrapAvailable = true
        await this.writeManifest(recordingDir, manifest)
        return manifest
    }

    async getBootstrap(recordingId) {
        const recordingDir = await this.findRecordingDir(recordingId)
        try {
            return await readJson(path.join(recordingDir, 'bootstrap.json'))
        } catch (error) {
            if (error.code === 'ENOENT') {
                error.statusCode = 404
                error.message = 'recording bootstrap not found'
            }
            throw error
        }
    }

    async getOrCreateWriter(recordingId) {
        const existing = this.active.get(recordingId)
        if (existing) return existing

        const recordingDir = await this.findRecordingDir(recordingId)
        const manifest = await this.getManifest(recordingId)
        if (manifest.status !== 'recording') {
            throw new Error(`recording is ${manifest.status}`)
        }
        const files = (await fsp.readdir(recordingDir)).filter(name => /^events-\d{5}\.jsonl$/.test(name)).sort()
        const chunkIndex = files.length
        const stream = fs.createWriteStream(path.join(recordingDir, `events-${String(chunkIndex).padStart(5, '0')}.jsonl`), { flags: 'a' })
        const writer = { recordingDir, manifest, stream, chunkIndex, chunkSize: 0 }
        this.active.set(recordingId, writer)
        return writer
    }

    async rotateWriter(writer) {
        writer.stream.end()
        await once(writer.stream, 'close')
        writer.chunkIndex++
        writer.chunkSize = 0
        const filename = `events-${String(writer.chunkIndex).padStart(5, '0')}.jsonl`
        writer.stream = fs.createWriteStream(path.join(writer.recordingDir, filename), { flags: 'a' })
    }

    validateEvent(event) {
        if (!event || !Number.isInteger(event.sequence) || event.sequence < 0) {
            throw new Error('capture event has invalid sequence')
        }
        if (!Number.isFinite(event.arrivalOffsetMs) || event.arrivalOffsetMs < 0) {
            throw new Error('capture event has invalid arrivalOffsetMs')
        }
        if (!Number.isFinite(event.marketTimeEpochMs) || event.marketTimeEpochMs <= 0) {
            throw new Error('capture event has invalid marketTimeEpochMs')
        }
        if (!isStoredMessage(event.message)) {
            throw new Error('unsupported replay event message')
        }
    }

    async appendEvents(recordingId, events) {
        if (!Array.isArray(events) || events.length === 0) return undefined
        const writer = await this.getOrCreateWriter(recordingId)
        for (const event of events) {
            this.validateEvent(event)
            const expectedSequence = writer.manifest.lastSequence + 1
            if (event.sequence !== expectedSequence) {
                writer.manifest.gaps.push({ expectedSequence, receivedSequence: event.sequence })
            }
            writer.manifest.lastSequence = Math.max(writer.manifest.lastSequence, event.sequence)
            writer.manifest.eventCount++
            writer.manifest.firstMarketEventEpochMs ||= event.marketTimeEpochMs
            writer.manifest.lastMarketEventEpochMs = Math.max(writer.manifest.lastMarketEventEpochMs, event.marketTimeEpochMs)
            if (event.message.type === 'timeSaleFlush') {
                writer.manifest.tradeRecordCount += event.message.trades.length
            } else if (event.message.type === 'quote') {
                writer.manifest.quoteEventCount++
            }

            const line = `${JSON.stringify(event)}\n`
            const lineBytes = Buffer.byteLength(line)
            if (writer.chunkSize > 0 && writer.chunkSize + lineBytes > this.chunkBytes) {
                await this.rotateWriter(writer)
            }
            writer.chunkSize += lineBytes
            if (!writer.stream.write(line)) {
                await once(writer.stream, 'drain')
            }
        }
        await this.writeManifest(writer.recordingDir, writer.manifest)
        return writer.manifest
    }

    async finalize(recordingId, options = {}) {
        this.closeCapture(recordingId)
        const writer = this.active.get(recordingId)
        let recordingDir
        let manifest
        if (writer) {
            recordingDir = writer.recordingDir
            manifest = writer.manifest
            writer.stream.end()
            await once(writer.stream, 'close')
            this.active.delete(recordingId)
        } else {
            recordingDir = await this.findRecordingDir(recordingId)
            manifest = await this.getManifest(recordingId)
        }

        manifest.droppedCaptureBatchCount += Math.max(0, Number(options.droppedCaptureBatchCount) || 0)
        manifest.finalizedAtEpochMs = Date.now()
        const requestedComplete = options.complete !== false
        const beganBeforeCutover = manifest.captureStartedAtEpochMs <= manifest.cutoverEpochMs
        const valid = manifest.bootstrapAvailable && manifest.eventCount > 0 && beganBeforeCutover &&
            manifest.gaps.length === 0 && manifest.droppedCaptureBatchCount === 0
        manifest.status = requestedComplete && valid ? 'complete' : 'incomplete'
        await this.writeManifest(recordingDir, manifest)
        return manifest
    }

    async listRecordings(filters = {}) {
        await fsp.mkdir(this.root, { recursive: true })
        const results = []
        const dates = await fsp.readdir(this.root, { withFileTypes: true })
        for (const dateEntry of dates) {
            if (!dateEntry.isDirectory() || (filters.date && dateEntry.name !== filters.date)) continue
            const dateDir = path.join(this.root, dateEntry.name)
            const symbols = await fsp.readdir(dateDir, { withFileTypes: true })
            for (const symbolEntry of symbols) {
                if (!symbolEntry.isDirectory() || (filters.symbol && symbolEntry.name !== filters.symbol)) continue
                const symbolDir = path.join(dateDir, symbolEntry.name)
                const recordings = await fsp.readdir(symbolDir, { withFileTypes: true })
                for (const recordingEntry of recordings) {
                    if (!recordingEntry.isDirectory()) continue
                    try {
                        const recordingDir = path.join(symbolDir, recordingEntry.name)
                        const manifest = await readJson(path.join(recordingDir, 'manifest.json'))
                        const isAbandoned = manifest.status === 'recording' &&
                            !this.activeCaptures.has(manifest.recordingId) &&
                            !this.active.has(manifest.recordingId) &&
                            Date.now() - manifest.createdAtEpochMs >= CAPTURE_CONNECT_GRACE_MS
                        if (isAbandoned) {
                            manifest.status = 'incomplete'
                            manifest.finalizedAtEpochMs = Date.now()
                            await this.writeManifest(recordingDir, manifest)
                        }
                        this.directoryCache.set(manifest.recordingId, recordingDir)
                        results.push(manifest)
                    } catch (error) {
                        console.error(`Failed to read replay manifest ${recordingEntry.name}:`, error.message)
                    }
                }
            }
        }
        results.sort((a, b) => b.createdAtEpochMs - a.createdAtEpochMs)
        return results
    }

    async *readEvents(recordingId) {
        const recordingDir = await this.findRecordingDir(recordingId)
        const files = (await fsp.readdir(recordingDir)).filter(name => /^events-\d{5}\.jsonl$/.test(name)).sort()
        for (const filename of files) {
            const input = fs.createReadStream(path.join(recordingDir, filename))
            const lines = readline.createInterface({ input, crlfDelay: Infinity })
            for await (const line of lines) {
                if (!line.trim()) continue
                try {
                    yield JSON.parse(line)
                } catch (error) {
                    console.error(`Ignoring malformed replay line in ${filename}:`, error.message)
                }
            }
        }
    }
}

module.exports = {
    ReplayStorage,
    DATE_PATTERN,
    SYMBOL_PATTERN,
    ID_PATTERN,
}
