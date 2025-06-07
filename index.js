const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const PORT = 5000

const app = express()

// Enable cors
app.use(cors())

app.use(bodyParser.urlencoded({
    extended: true,
}));

app.use(bodyParser.json());
// Set static folder
// app.use(express.static('public'))

// Routes
app.use('/tradeStationApi', require('./routes/tradeStation'));
app.use('/schwabApi', require('./routes/schwab'));
app.use('/save', require('./routes/save'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`))