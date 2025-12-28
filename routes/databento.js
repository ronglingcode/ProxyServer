const express = require('express')
const router = express.Router()
const fs = require('fs')
const path = require('path')

router.use(express.json())

function getCurrentTimestamp() {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    return time;
}

function getLogFilename() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const filename = `${year}-${month}-${day}.log`;
    return path.join(__dirname, '..', 'data', filename);
}

// Helper function to print logs with timestamp
function printLog(message) {
    const logMessage = `[${getCurrentTimestamp()}] ${message}`;
    console.log(logMessage);
    try {
        fs.appendFileSync(getLogFilename(), logMessage + '\n');
    } catch (error) {
        console.error('Error writing to log file:', error);
    }
}

function printObjectLog(object) {
    const timestamp = `[${getCurrentTimestamp()}]`;
    console.log(timestamp);
    console.log(object);
    try {
        fs.appendFileSync(getLogFilename(), timestamp + '\n' + JSON.stringify(object, null, 2) + '\n');
    } catch (error) {
        console.error('Error writing to log file:', error);
    }
}

const Databento_API_Host = "https://hist.databento.com";

/**
 * POST endpoint to fetch historical timeseries data from Databento
 * This proxies requests to avoid CORS issues
 * 
 * Request body should contain:
 * - dataset: string (e.g., "DBEQ.BASIC")
 * - start: string (ISO format, e.g., "2024-04-03T08:00:00")
 * - end: string (ISO format, e.g., "2024-04-03T14:00:00")
 * - symbols: string[] (e.g., ["GOOG", "GOOGL"])
 * - schema: string (e.g., "mbo")
 * 
 * Authorization header should contain: "Bearer <apiKey>"
 * The proxy converts this to HTTP Basic Authentication for Databento API
 */
router.post('/v0/timeseries.get_range', async (req, res) => {
    try {
        printLog('Databento timeseries.get_range request');
        printLog(`Request body type: ${typeof req.body}`);
        printLog(`Request body keys: ${Object.keys(req.body || {}).join(', ')}`);
        printObjectLog(req.body);
        
        const reqBody = req.body;
        const apiUrl = `${Databento_API_Host}/v0/timeseries.get_range`;
        
        // Validate required fields
        if (!reqBody || !reqBody.dataset || !reqBody.start) {
            printLog('ERROR: Missing required fields in request body');
            printObjectLog({ received: reqBody, required: ['dataset', 'start', 'end', 'symbols', 'schema'] });
            return res.status(400).json({ 
                error: 'Missing required fields',
                details: 'Request body must contain: dataset, start, end, symbols, schema'
            });
        }
        
        // Get API key from Authorization header
        const authHeader = req.header('Authorization');
        if (!authHeader) {
            printLog('ERROR: Authorization header is missing');
            return res.status(401).json({ error: 'Authorization header is required' });
        }
        
        printLog(`Authorization header received: ${authHeader.substring(0, 20)}...`);
        
        // Extract API key from Bearer token format
        // Databento API uses HTTP Basic Authentication: Basic base64(apiKey:)
        let apiKey = authHeader;
        if (authHeader.startsWith('Bearer ')) {
            apiKey = authHeader.substring(7); // Remove "Bearer " prefix
            printLog('Extracted API key from Bearer token');
            printLog(`API key: ${apiKey}`);
        }
        
        // Databento uses Basic Auth: username is API key, password is empty
        // Format: Basic base64(apiKey:)
        const basicAuth = Buffer.from(`${apiKey}:`).toString('base64');
        const basicAuthHeader = `Basic ${basicAuth}`;
        printLog('Using Basic Authentication');
        
        // Databento API expects form-encoded data (curl example uses -d flags)
        // Convert JSON body to URLSearchParams format
        const formData = new URLSearchParams();
        
        // Required fields
        if (reqBody.dataset) formData.append('dataset', reqBody.dataset);
        if (reqBody.start) formData.append('start', reqBody.start);
        if (reqBody.end) formData.append('end', reqBody.end);
        if (reqBody.schema) formData.append('schema', reqBody.schema);
        
        // Symbols can be a single string or array
        if (reqBody.symbols) {
            if (Array.isArray(reqBody.symbols)) {
                // If symbols is an array, append each symbol separately
                reqBody.symbols.forEach(symbol => formData.append('symbols', symbol));
            } else {
                // Single symbol as string
                formData.append('symbols', reqBody.symbols);
            }
        }
        
        // Optional fields
        if (reqBody.encoding) formData.append('encoding', reqBody.encoding);
        if (reqBody.pretty_px !== undefined) formData.append('pretty_px', reqBody.pretty_px.toString());
        if (reqBody.pretty_ts !== undefined) formData.append('pretty_ts', reqBody.pretty_ts.toString());
        if (reqBody.map_symbols !== undefined) formData.append('map_symbols', reqBody.map_symbols.toString());
        if (reqBody.limit) formData.append('limit', reqBody.limit.toString());
        
        const formDataString = formData.toString();
        printLog(`Form data: ${formDataString}`);
        
        // Make request to Databento API with Basic Auth and form-encoded data
        const databentoResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': basicAuthHeader, // Basic Auth: Basic base64(apiKey:)
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: formDataString
        });
        
        // Check if response is OK
        if (!databentoResponse.ok) {
            const errorText = await databentoResponse.text();
            printLog(`Databento API error: ${databentoResponse.status} ${databentoResponse.statusText}`);
            printLog(`Error details: ${errorText}`);
            printLog(`Request URL: ${apiUrl}`);
            printLog(`Request headers sent: Authorization: Basic (using API key: ${apiKey.substring(0, 10)}...)`);
            return res.status(databentoResponse.status).json({ 
                error: `Databento API error: ${databentoResponse.status} ${databentoResponse.statusText}`,
                details: errorText 
            });
        }
        
        // Always return JSON, regardless of Databento response type
        const contentType = databentoResponse.headers.get('content-type');
        let responseData;
        
        try {
            if (contentType && contentType.includes('application/json')) {
                // Read as text first, then try to parse as JSON
                // This way we can handle both valid JSON and invalid JSON
                const text = await databentoResponse.text();
                printLog(`Databento response (JSON) received, length: ${text.length} chars`);
                
                try {
                    responseData = JSON.parse(text);
                    printLog('Successfully parsed JSON response');
                } catch (parseError) {
                    // If JSON parsing fails, wrap the text in a JSON object
                    printLog(`Failed to parse as JSON: ${parseError.message}`);
                    printLog(`Response preview: ${text.substring(0, 500)}`);
                    responseData = {
                        contentType: contentType,
                        dataType: 'text',
                        size: text.length,
                        data: text,
                        parseError: parseError.message
                    };
                }
            } else {
                // Binary data (DBN format) - convert to base64 and wrap in JSON
                const arrayBuffer = await databentoResponse.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const base64Data = buffer.toString('base64');
                
                printLog(`Databento response (binary) received: ${arrayBuffer.byteLength} bytes`);
                
                // Build JSON response with binary data as base64
                responseData = {
                    contentType: contentType || 'application/octet-stream',
                    dataType: 'binary',
                    size: arrayBuffer.byteLength,
                    data: base64Data // Base64-encoded binary data
                };
            }
        } catch (responseError) {
            printLog(`Error processing Databento response: ${responseError.message}`);
            printObjectLog(responseError);
            return res.status(500).json({
                error: 'Error processing Databento response',
                details: responseError.message
            });
        }
        
        // Always return JSON
        res.status(200).json(responseData);
    } catch (error) {
        printLog('Error in Databento proxy request');
        printObjectLog(error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

module.exports = router

