const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let client = null;
let isConnected = false;
let isSending = false;

// Create sessions directory
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir);

// Serve HTML directly from this file
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bulk Message Sender</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            min-height: 100vh;
            background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 20px;
            position: relative;
        }
        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: radial-gradient(circle at 50% 50%, rgba(0,255,255,0.15) 0%, rgba(0,0,0,0.6) 100%);
            backdrop-filter: blur(8px);
            pointer-events: none;
            z-index: 0;
        }
        .container {
            max-width: 1600px;
            margin: 0 auto;
            position: relative;
            z-index: 1;
        }
        .header {
            text-align: center;
            padding: 30px;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            margin-bottom: 30px;
            border: 1px solid rgba(0, 255, 255, 0.3);
            animation: glow 2s ease-in-out infinite alternate;
        }
        @keyframes glow {
            from { box-shadow: 0 0 20px rgba(0, 255, 255, 0.2); }
            to { box-shadow: 0 0 40px rgba(0, 255, 255, 0.5); }
        }
        .header h1 {
            color: #00ffff;
            font-size: 2.5em;
            text-shadow: 0 0 15px rgba(0, 255, 255, 0.8);
        }
        .status-bar {
            display: inline-block;
            margin-left: 20px;
            padding: 5px 15px;
            background: rgba(0,0,0,0.5);
            border-radius: 20px;
            font-size: 14px;
        }
        .status-connected { color: #00ff00; }
        .status-disconnected { color: #ff0000; }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
            gap: 25px;
            margin-bottom: 25px;
        }
        .card {
            background: rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(15px);
            border-radius: 20px;
            padding: 25px;
            border: 1px solid rgba(0, 255, 255, 0.2);
            transition: all 0.3s ease;
        }
        .card:hover {
            border-color: rgba(0, 255, 255, 0.6);
            box-shadow: 0 0 30px rgba(0, 255, 255, 0.3);
        }
        .card-title {
            color: #00ffff;
            font-size: 1.5em;
            margin-bottom: 20px;
            border-bottom: 2px solid rgba(0, 255, 255, 0.3);
            padding-bottom: 10px;
        }
        .input-group { margin-bottom: 18px; }
        label {
            display: block;
            color: #fff;
            margin-bottom: 8px;
            font-size: 0.95em;
            font-weight: 500;
        }
        input, textarea, select {
            width: 100%;
            padding: 12px;
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(0, 255, 255, 0.3);
            border-radius: 10px;
            color: #fff;
            font-size: 14px;
        }
        input:focus, textarea:focus {
            outline: none;
            border-color: #00ffff;
            background: rgba(255, 255, 255, 0.2);
        }
        button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 12px 25px;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            font-size: 15px;
            font-weight: bold;
            margin-right: 10px;
            margin-top: 10px;
            transition: all 0.3s ease;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(0, 255, 255, 0.4);
        }
        button.danger { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
        button.success { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); }
        .console {
            background: rgba(0, 0, 0, 0.85);
            border-radius: 20px;
            padding: 20px;
            margin-top: 25px;
        }
        .console-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .console-title { color: #00ffff; font-size: 1.3em; font-weight: bold; }
        .console-logs {
            background: rgba(0, 0, 0, 0.5);
            height: 300px;
            overflow-y: auto;
            padding: 15px;
            border-radius: 10px;
            font-family: 'Courier New', monospace;
            font-size: 12px;
        }
        .log-entry { padding: 5px; margin: 5px 0; border-left: 3px solid #00ffff; color: #0f0; }
        .log-error { border-left-color: #ff0000; color: #ff6666; }
        .log-success { border-left-color: #00ff00; color: #00ff00; }
        .log-warning { border-left-color: #ffff00; color: #ffff00; }
        .qr-container { text-align: center; margin-top: 15px; }
        .qr-container img { max-width: 200px; border-radius: 10px; }
        .progress-bar {
            width: 100%;
            height: 30px;
            background: rgba(255,255,255,0.1);
            border-radius: 15px;
            overflow: hidden;
            margin-top: 10px;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #00ffff, #4facfe);
            transition: width 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 WhatsApp Bulk Message Sender <span id="statusIndicator" class="status-bar status-disconnected">● Disconnected</span></h1>
            <p>Advanced Messaging System with Multi-Device Support</p>
        </div>
        <div class="grid">
            <div class="card">
                <div class="card-title">📱 STEP 1: DEVICE PAIRING</div>
                <div class="input-group">
                    <label>📞 Your Number (with country code)</label>
                    <input type="text" id="userNumber" placeholder="923001234567">
                </div>
                <button class="success" onclick="getPairingCode()">🔐 GET PAIRING CODE</button>
                <button class="success" onclick="connectDevice()">🔗 CONNECT DEVICE</button>
                <div id="qrContainer" class="qr-container"></div>
                <div id="pairingCodeDisplay" style="margin-top: 10px; color: #00ff00; font-weight: bold;"></div>
            </div>
            <div class="card">
                <div class="card-title">📤 STEP 2: SEND MESSAGES</div>
                <div class="input-group">
                    <label>🎯 Target Type</label>
                    <select id="targetType">
                        <option value="number">Phone Number</option>
                        <option value="group">Group ID</option>
                    </select>
                </div>
                <div class="input-group">
                    <label>📞 Target Number(s) / Group ID</label>
                    <textarea id="targets" rows="3" placeholder="923001234567&#10;923009876543"></textarea>
                    <input type="text" id="groupId" placeholder="Or Group ID" style="display:none;">
                </div>
                <div class="input-group">
                    <label>📄 Message Prefix</label>
                    <input type="text" id="messagePrefix" placeholder="Hello">
                </div>
                <div class="input-group">
                    <label>💬 Message Content</label>
                    <textarea id="messageText" rows="3" placeholder="Your message here..."></textarea>
                </div>
                <div class="input-group">
                    <label>⏱️ Delay (seconds)</label>
                    <input type="number" id="delay" value="2" min="1">
                </div>
                <div class="input-group">
                    <label>🔄 Cycles (-1 = Infinite)</label>
                    <input type="number" id="cycles" value="1" min="-1">
                </div>
                <button class="success" onclick="startSending()">▶ START SENDING</button>
                <button class="danger" onclick="stopSending()">⏹️ STOP SENDING</button>
                <div id="progressContainer" style="display:none;">
                    <div class="progress-bar"><div class="progress-fill" id="progressFill">0%</div></div>
                    <p id="progressText" style="color:white; margin-top:10px;"></p>
                </div>
            </div>
            <div class="card">
                <div class="card-title">⚙️ STEP 3: SESSION CONTROL</div>
                <button onclick="viewSession()">👁️ VIEW SESSION</button>
                <button onclick="getGroups()">👥 GET GROUPS</button>
                <button class="danger" onclick="stopSession()">🛑 STOP SESSION</button>
                <div id="groupsList" style="margin-top: 15px; max-height: 200px; overflow-y: auto;"></div>
            </div>
        </div>
        <div class="console">
            <div class="console-header">
                <div class="console-title">📋 LIVE CONSOLE LOGS</div>
                <button onclick="clearLogs()">🗑️ CLEAR LOGS</button>
            </div>
            <div class="console-logs" id="consoleLogs"></div>
        </div>
    </div>
    <script>
        const socket = io();
        function addLog(message, type) {
            const logsDiv = document.getElementById('consoleLogs');
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry log-' + (type || 'info');
            logEntry.innerHTML = '[' + new Date().toLocaleTimeString() + '] ' + message;
            logsDiv.appendChild(logEntry);
            logsDiv.scrollTop = logsDiv.scrollHeight;
        }
        function clearLogs() { document.getElementById('consoleLogs').innerHTML = ''; addLog('Console cleared', 'info'); }
        socket.on('log', (data) => { addLog(data.message, data.type); });
        socket.on('qr', (qrData) => {
            document.getElementById('qrContainer').innerHTML = '<img src="' + qrData + '" alt="QR Code"><p style="color:white; margin-top:10px;">Scan QR code with WhatsApp</p>';
            addLog('QR Code generated - Scan to connect', 'warning');
        });
        socket.on('connected', (status) => {
            const indicator = document.getElementById('statusIndicator');
            if(status) {
                indicator.innerHTML = '● Connected';
                indicator.className = 'status-bar status-connected';
                addLog('WhatsApp connected successfully!', 'success');
            } else {
                indicator.innerHTML = '● Disconnected';
                indicator.className = 'status-bar status-disconnected';
                addLog('WhatsApp disconnected', 'error');
            }
        });
        socket.on('pairingCode', (code) => {
            document.getElementById('pairingCodeDisplay').innerHTML = 'Pairing Code: ' + code + '<br>Use this code in WhatsApp linked devices';
            addLog('Pairing code received: ' + code, 'success');
        });
        socket.on('groups', (groups) => {
            const groupsDiv = document.getElementById('groupsList');
            groupsDiv.innerHTML = '<h4 style="color:#00ffff;">Your Groups:</h4>';
            groups.forEach(group => {
                groupsDiv.innerHTML += '<div style="color:white; padding:5px; border-bottom:1px solid rgba(0,255,255,0.3);"><strong>' + group.name + '</strong><br>ID: ' + group.id + '<br>Members: ' + group.participantCount + '</div>';
            });
            addLog('Loaded ' + groups.length + ' groups', 'success');
        });
        socket.on('progress', (data) => {
            const percent = Math.round((data.current / data.total) * 100);
            document.getElementById('progressFill').style.width = percent + '%';
            document.getElementById('progressFill').innerHTML = percent + '%';
            document.getElementById('progressText').innerHTML = 'Sent: ' + data.sent + ' messages | Progress: ' + data.current + '/' + data.total;
        });
        socket.on('completed', (data) => {
            document.getElementById('progressContainer').style.display = 'none';
            addLog('Sending completed! Total sent: ' + data.totalSent + ' messages in ' + data.cycles + ' cycles', 'success');
        });
        function getPairingCode() {
            const number = document.getElementById('userNumber').value;
            if(!number) { addLog('Please enter your number', 'error'); return; }
            socket.emit('getPairingCode', number);
            addLog('Requesting pairing code for ' + number + '...', 'info');
        }
        function connectDevice() { socket.emit('connectDevice'); addLog('Connecting device...', 'info'); }
        function getGroups() { socket.emit('getGroups'); addLog('Fetching groups...', 'info'); }
        function viewSession() { addLog('Session active: ' + (document.getElementById('statusIndicator').innerHTML.includes('Connected') ? 'Connected' : 'Disconnected'), 'info'); }
        function stopSession() { socket.emit('stopSending'); addLog('Session stopped by user', 'warning'); }
        function startSending() {
            const targetType = document.getElementById('targetType').value;
            const targets = document.getElementById('targets').value;
            const groupId = document.getElementById('groupId').value;
            const messagePrefix = document.getElementById('messagePrefix').value;
            const messageText = document.getElementById('messageText').value;
            const delay = parseInt(document.getElementById('delay').value);
            const cycles = parseInt(document.getElementById('cycles').value);
            if(!messageText) { addLog('Please enter a message', 'error'); return; }
            const fullMessage = messagePrefix ? messagePrefix + '\\n' + messageText : messageText;
            const data = { targetType, targets: targetType === 'number' ? targets : '', groupId: targetType === 'group' ? groupId : '', messageText: fullMessage, delay, cycles };
            document.getElementById('progressContainer').style.display = 'block';
            socket.emit('startSending', data);
            addLog('Starting message sending...', 'success');
        }
        function stopSending() { socket.emit('stopSending'); addLog('Stopping message sending...', 'warning'); }
        document.getElementById('targetType').addEventListener('change', function() {
            const isGroup = this.value === 'group';
            document.getElementById('targets').style.display = isGroup ? 'none' : 'block';
            document.getElementById('groupId').style.display = isGroup ? 'block' : 'none';
        });
    </script>
</body>
</html>
    `);
});

// Socket.IO events
io.on('connection', (socket) => {
    console.log('Client connected');
    
    socket.on('getPairingCode', async (number) => {
        try {
            if (!client) {
                client = new Client({
                    authStrategy: new LocalAuth({ dataPath: sessionsDir }),
                    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
                });
                await client.initialize();
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            const code = await client.requestPairingCode(number);
            io.emit('pairingCode', code);
            addLog(`Pairing code for ${number}: ${code}`);
        } catch (error) {
            addLog(`Error: ${error.message}`, 'error');
        }
    });
    
    socket.on('connectDevice', async () => {
        try {
            if (!client) {
                client = new Client({
                    authStrategy: new LocalAuth({ dataPath: sessionsDir }),
                    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
                });
                
                client.on('qr', async (qr) => {
                    const qrImage = await QRCode.toDataURL(qr);
                    io.emit('qr', qrImage);
                    addLog('QR Code generated', 'warning');
                });
                
                client.on('ready', () => {
                    isConnected = true;
                    io.emit('connected', true);
                    addLog('WhatsApp Client Ready!', 'success');
                });
                
                client.on('disconnected', () => {
                    isConnected = false;
                    io.emit('connected', false);
                    addLog('Client disconnected', 'error');
                });
                
                await client.initialize();
            }
            addLog('Device connection initiated', 'info');
        } catch (error) {
            addLog(`Connection error: ${error.message}`, 'error');
        }
    });
    
    socket.on('getGroups', async () => {
        try {
            if (!client || !isConnected) {
                addLog('Client not connected', 'error');
                return;
            }
            const chats = await client.getChats();
            const groups = chats.filter(chat => chat.isGroup).map(group => ({
                id: group.id._serialized,
                name: group.name,
                participantCount: group.participants.length
            }));
            io.emit('groups', groups);
            addLog(`Found ${groups.length} groups`, 'success');
        } catch (error) {
            addLog(`Error: ${error.message}`, 'error');
        }
    });
    
    socket.on('startSending', async (data) => {
        if (isSending) {
            addLog('Already sending messages!', 'warning');
            return;
        }
        isSending = true;
        try {
            let targets = data.targetType === 'number' ? data.targets.split('\\n').filter(t => t.trim()) : [data.groupId];
            let totalSent = 0;
            let cycleCount = 0;
            let cycles = data.cycles;
            
            while (cycles === -1 || cycleCount < cycles) {
                if (!isSending) break;
                cycleCount++;
                addLog(`Starting cycle ${cycleCount}`, 'info');
                
                for (let i = 0; i < targets.length; i++) {
                    if (!isSending) break;
                    const target = targets[i].trim();
                    if (target) {
                        await new Promise(resolve => setTimeout(resolve, data.delay * 1000));
                        try {
                            let chatId = target.includes('@') ? target : `${target}@c.us`;
                            await client.sendMessage(chatId, data.messageText);
                            totalSent++;
                            addLog(`✅ Sent to ${target}`, 'success');
                            socket.emit('progress', { current: i + 1, total: targets.length, sent: totalSent });
                        } catch (err) {
                            addLog(`❌ Failed to send to ${target}: ${err.message}`, 'error');
                        }
                    }
                }
            }
            io.emit('completed', { totalSent, cycles: cycleCount });
            addLog(`Completed! Sent ${totalSent} messages`, 'success');
        } catch (error) {
            addLog(`Error: ${error.message}`, 'error');
        } finally {
            isSending = false;
        }
    });
    
    socket.on('stopSending', () => {
        isSending = false;
        addLog('Stopping message sending...', 'warning');
    });
});

function addLog(message, type = 'info') {
    io.emit('log', { message, type });
    console.log(`[${type}] ${message}`);
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    addLog(`Server started on port ${PORT}`, 'success');
});

// Initialize client on startup
(async () => {
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: sessionsDir }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });
    
    client.on('qr', async (qr) => {
        const qrImage = await QRCode.toDataURL(qr);
        io.emit('qr', qrImage);
        addLog('QR Code generated - Scan to connect', 'warning');
    });
    
    client.on('ready', () => {
        isConnected = true;
        io.emit('connected', true);
        addLog('✅ WhatsApp Client Ready!', 'success');
    });
    
    client.on('disconnected', () => {
        isConnected = false;
        io.emit('connected', false);
        addLog('❌ Client disconnected', 'error');
    });
    
    await client.initialize();
})();
