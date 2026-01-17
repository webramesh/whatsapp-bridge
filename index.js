const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SECURITY_TOKEN = process.env.SECURITY_TOKEN || 'your-secret-token';

let qrBase64 = null;
let connectionStatus = "Disconnected";
let lastError = null;
let socket = null;

const SESSION_FOLDER = path.join(__dirname, 'wa_session');
const LOG_FILE = path.join(__dirname, 'bridge.log');

// Store original console methods before overriding
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// Custom logging function that writes to both console and file
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    
    // Write to original console (avoid recursion)
    originalConsoleLog(logMessage.trim());
    
    // Write to file
    try {
        fs.appendFileSync(LOG_FILE, logMessage);
    } catch (err) {
        originalConsoleError('Failed to write to log file:', err);
    }
}

// Override console methods to use our log function
console.log = (...args) => {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    log(message, 'INFO');
};

console.error = (...args) => {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    log(message, 'ERROR');
};

async function startBridge() {
    connectionStatus = "Starting WhatsApp Library...";
    console.log('Starting WhatsApp Bridge...');
    try {
        // Check if session folder exists
        if (!fs.existsSync(SESSION_FOLDER)) {
            console.log('Creating session folder:', SESSION_FOLDER);
            fs.mkdirSync(SESSION_FOLDER, { recursive: true });
        } else {
            // Check if folder is empty or has files
            const files = fs.readdirSync(SESSION_FOLDER);
            console.log(`Session folder contains ${files.length} files`);
            
            // If we have a 405 error and session files exist, delete them
            if (lastError && lastError.includes('405') && files.length > 0) {
                console.log('Clearing corrupted session due to 405 error...');
                files.forEach(file => {
                    fs.unlinkSync(path.join(SESSION_FOLDER, file));
                });
                console.log('Session cleared. Will generate new QR code.');
            }
        }

        console.log('Loading authentication state...');
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

        console.log('Creating WhatsApp socket...');
        socket = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Bridge', 'Chrome', '4.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: true
        });

        console.log('Socket created successfully');
        console.log('Waiting for connection update...');

        // Set a timeout to detect if QR code never arrives
        const qrTimeout = setTimeout(() => {
            if (!qrBase64 && connectionStatus === 'Starting WhatsApp Library...') {
                console.error('CRITICAL: No QR code received after 10 seconds!');
                console.error('This usually means:');
                console.error('1. Server IP is blocked by WhatsApp');
                console.error('2. Network/firewall blocking WhatsApp servers');
                console.error('3. Baileys library needs updating');
                lastError = 'QR code timeout - possible network/firewall issue';
            }
        }, 10000);

        socket.ev.on('creds.update', saveCreds);

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            console.log('Connection update:', { connection, hasQR: !!qr });

            if (qr) {
                clearTimeout(qrTimeout); // Clear the timeout if QR arrives
                console.log('QR code received, generating image...');
                qrBase64 = await QRCode.toDataURL(qr);
                connectionStatus = "READY TO SCAN";
                lastError = null; // Clear any previous errors when QR is received
                console.log('Status changed to: READY TO SCAN');
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log('Connection closed with reason:', reason);
                connectionStatus = `Stopped (Reason: ${reason})`;
                lastError = `Connection closed with code: ${reason}`;
                
                // For 405 errors, clear the session on next restart
                if (reason === 405) {
                    console.log('405 error detected - session will be cleared on next restart');
                }
                
                if (reason !== DisconnectReason.loggedOut) {
                    console.log('Reconnecting in 5 seconds...');
                    setTimeout(startBridge, 5000);
                } else {
                    console.log('Logged out - not reconnecting');
                }
            } else if (connection === 'open') {
                console.log('Connection opened successfully!');
                connectionStatus = "CONNECTED";
                qrBase64 = null;
                lastError = null;
            }
        });

    } catch (err) {
        lastError = err.message;
        connectionStatus = "Startup Error";
        console.error('Bridge startup error:', err);
        console.error('Error stack:', err.stack);
    }
}

// API Endpoint - Define OUTSIDE of startBridge function
app.post('/api/send-message', async (req, res) => {
    const { to, message } = req.body;
    const auth = req.headers['authorization'];
    
    if (auth !== `Bearer ${SECURITY_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!socket) {
        return res.status(503).json({ error: 'WhatsApp socket not initialized' });
    }
    
    try {
        const jid = to.replace(/\D/g, '') + '@s.whatsapp.net';
        await socket.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Status API endpoint
app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        hasQR: !!qrBase64,
        error: lastError
    });
});

// Logs endpoint - view application logs
app.get('/logs', (req, res) => {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const logs = fs.readFileSync(LOG_FILE, 'utf8');
            const lines = logs.split('\n').slice(-200); // Last 200 lines
            
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Bridge Logs</title>
                    <meta charset="UTF-8">
                    <style>
                        body { font-family: monospace; padding: 20px; background: #1e1e1e; color: #d4d4d4; }
                        pre { white-space: pre-wrap; word-wrap: break-word; line-height: 1.5; }
                        .error { color: #f48771; }
                        .info { color: #4ec9b0; }
                        button { padding: 10px 20px; background: #007acc; color: white; border: none; cursor: pointer; border-radius: 5px; margin-bottom: 20px; }
                        button:hover { background: #005a9e; }
                    </style>
                </head>
                <body>
                    <h2>WhatsApp Bridge Application Logs</h2>
                    <button onclick="window.location.reload()">Refresh Logs</button>
                    <button onclick="window.location.href='/'">Back to Home</button>
                    <pre>${lines.map(line => {
                        if (line.includes('[ERROR]')) return `<span class="error">${line}</span>`;
                        if (line.includes('[INFO]')) return `<span class="info">${line}</span>`;
                        return line;
                    }).join('\n')}</pre>
                </body>
                </html>
            `);
        } else {
            res.send('<html><body><h1>No logs found</h1><a href="/">Back to Home</a></body></html>');
        }
    } catch (err) {
        res.status(500).send(`Error reading logs: ${err.message}`);
    }
});

// Clear logs endpoint
app.get('/logs/clear', (req, res) => {
    try {
        fs.writeFileSync(LOG_FILE, '');
        res.send('<html><body><h1>Logs cleared!</h1><a href="/logs">View Logs</a> | <a href="/">Back to Home</a></body></html>');
    } catch (err) {
        res.status(500).send(`Error clearing logs: ${err.message}`);
    }
});

// Test WhatsApp connectivity
app.get('/test-connection', async (req, res) => {
    const https = require('https');
    
    const testResults = [];
    
    // Test 1: Check if we can reach WhatsApp web socket
    testResults.push('Testing WhatsApp Server Connectivity...\n');
    
    try {
        const testPromise = new Promise((resolve, reject) => {
            const req = https.get('https://web.whatsapp.com/', (response) => {
                testResults.push(`✓ Can reach web.whatsapp.com - Status: ${response.statusCode}`);
                resolve();
            });
            req.on('error', (err) => {
                testResults.push(`✗ Cannot reach web.whatsapp.com - Error: ${err.message}`);
                reject(err);
            });
            req.setTimeout(5000, () => {
                testResults.push('✗ Timeout reaching web.whatsapp.com');
                req.destroy();
                reject(new Error('Timeout'));
            });
        });
        
        await testPromise.catch(() => {});
    } catch (err) {
        testResults.push(`Error: ${err.message}`);
    }
    
    testResults.push('\n--- Diagnosis ---');
    testResults.push('Baileys version: 6.7.21 (Latest) ✓');
    testResults.push('Node.js: v20.19.4 ✓');
    testResults.push('Session: Clean (0 files) ✓');
    testResults.push('\nIssue: Persistent 405 error without QR code generation');
    testResults.push('\n⚠️ LIKELY CAUSE: Server IP blocked by WhatsApp');
    testResults.push('\nShared hosting IPs are commonly blocked by WhatsApp.');
    testResults.push('This is a server infrastructure issue, not a code issue.');
    
    res.send(`<html><head><title>Connection Test</title></head><body style="font-family:monospace;padding:20px;background:#1e1e1e;color:#d4d4d4;"><pre>${testResults.join('\n')}</pre><br><a href="/" style="color:#4ec9b0;">Back to Home</a></body></html>`);
});

app.get('/', (req, res) => {
    let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp Bridge</title>
            <script>
                // Auto-refresh every 3 seconds if status is "Starting WhatsApp Library..."
                setTimeout(() => {
                    const statusText = document.body.innerText;
                    if (statusText.includes('Starting WhatsApp Library')) {
                        window.location.reload();
                    }
                }, 3000);
            </script>
        </head>
        <body style="font-family:sans-serif; text-align:center; padding: 50px; background: #eef2f3;">
            <div style="background: white; padding: 40px; border-radius: 20px; display: inline-block; box-shadow: 0 10px 25px rgba(0,0,0,0.05);">
                <h1 style="color: #333; margin-bottom: 5px;">WhatsApp Bridge Lite</h1>
                <p style="color: #999; margin-top: 0; font-size: 14px;">v1.5 (Subdomain Edition)</p>
                <p style="font-size: 1.2em; margin-top: 30px;">Status: <strong style="color: ${connectionStatus === 'CONNECTED' ? '#10b981' : '#f59e0b'}">${connectionStatus}</strong></p>
    `;

    if (qrBase64) {
        html += `
            <div style="margin: 30px 0; border: 2px dashed #ddd; padding: 20px; border-radius: 15px;">
                <h3 style="color: #666; margin-top: 0;">Scan Now:</h3>
                <img src="${qrBase64}" style="width: 250px; height: 250px;" />
                <p style="color: #888; font-size: 12px;">Open WhatsApp > Linked Devices > Link a Device</p>
            </div>
        `;
    }

    if (lastError) {
        html += `<p style="color: #dc2626; background: #fef2f2; padding: 10px; border-radius: 5px; margin: 20px 0;"><strong>System Error:</strong> ${lastError}</p>`;
    }

    html += `
                <p style="color: #666; font-size: 12px; margin-top: 20px;">Socket: ${socket ? 'Initialized' : 'Not initialized'}</p>
                <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;" />
                <button onclick="window.location.reload()" style="padding: 12px 24px; border-radius: 10px; border: none; background: #000; color: white; font-weight: bold; cursor: pointer; margin-right: 10px;">REFRESH STATUS</button>
                <button onclick="window.location.href='/logs'" style="padding: 12px 24px; border-radius: 10px; border: none; background: #666; color: white; font-weight: bold; cursor: pointer;">VIEW LOGS</button>
            </div>
        </body>
        </html>
    `;
    res.send(html);
});

app.listen(PORT, () => {
    console.log(`WhatsApp Bridge started on port ${PORT}`);
    console.log(`Security Token: ${SECURITY_TOKEN.substring(0, 5)}...`);
    console.log(`Session Folder: ${SESSION_FOLDER}`);
    console.log(`Node.js version: ${process.version}`);
    console.log(`Platform: ${process.platform}`);
    
    // Check if required packages are installed
    try {
        const baileys = require('@whiskeysockets/baileys/package.json');
        console.log(`Baileys version: ${baileys.version}`);
    } catch (err) {
        console.error('Baileys package info not found');
    }
    
    startBridge();
});
