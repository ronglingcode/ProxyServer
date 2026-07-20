const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const http = require('http')
const { ReplayStorage } = require('./replay/storage')
const { attachReplayWebSockets } = require('./replay/websockets')
const PORT = 3000

const app = express()
const server = http.createServer(app)
const replayStorage = new ReplayStorage({ root: process.env.REPLAY_DATA_ROOT })

// Enable cors
app.use(cors())

app.use(bodyParser.urlencoded({
    extended: true,
}));

app.use(bodyParser.json({ limit: '25mb' }));
// Set static folder
// app.use(express.static('public'))

// Routes
app.use('/tradeStationApi', require('./routes/tradeStation'));
app.use('/schwabApi', require('./routes/schwab'));
app.use('/save', require('./routes/save'));
app.use('/databento', require('./routes/databento'));
app.use('/replay', require('./routes/replay')(replayStorage));

attachReplayWebSockets(server, replayStorage)

server.listen(PORT, () => console.log(`Server running on port ${PORT}`))
