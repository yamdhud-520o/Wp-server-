const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// ============ CONFIGURATION ============
let client = null;
let isConnected = false;
let isSending = false;

// User Agent Headers
const USER_AGENTS = {
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
};

// Create directories
const sessionsDir = path.join(__dirname, 'sessions');
const logsDir = path.join(__dirname, 'logs');
const dataDir = path.join(__dirname, 'data');

if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir);
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Stats file
const statsFile = path.join(dataDir, 'stats.json');
if (!fs.existsSync(statsFile)) {
    fs.writeFileSync(statsFile, JSON.stringify({ totalSent: 0, startDate: new Date().toISOString(), history: [] }));
}

// ============ HELPER FUNCTIONS ============
function saveStats(sent) {
    try {
        const stats = JSON.parse(fs.readFileSync(statsFile));
        stats.totalSent += sent;
        stats.history.push({ time: new Date().toISOString(), count: sent });
        if (stats.history.length > 100) stats.history.shift();
        fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
    } catch(e) {}
}

function logToFile(message, type = 'info') {
    const logFile = path.join(logsDir, `${new Date().toISOString().split('T')[0]}.log`);
    const logLine = `[${new Date().toISOString()}] [${type.toUpperCase()}] ${message}\n`;
    fs.appendFileSync(logFile, logLine);
}

function addLog(message, type = 'info') {
    const logData = { message, type, timestamp: new Date().toLocaleTimeString() };
    io.emit('log', logData);
    console.log(`[${type}] ${message}`);
    logToFile(message, type);
}

// ============ WHATSAPP CLIENT INITIALIZATION ============
function initializeClient() {
    addLog('Initializing WhatsApp Client...', 'info');
    
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: sessionsDir }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
                '--disable-blink-features=AutomationControlled'
            ]
        },
        userAgent: USER_AGENTS.chrome
    });

    client.on('qr', async (qr) => {
        addLog('QR Code received! Scan with WhatsApp', 'warning');
        try {
            const qrImage = await QRCode.toDataURL(qr);
            io.emit('qr', qrImage);
        } catch (err) {
            addLog('QR generation error: ' + err.message, 'error');
        }
    });

    client.on('ready', () => {
        isConnected = true;
        addLog('✅ WhatsApp Client Ready!', 'success');
        io.emit('connected', true);
        sendStartupNotification();
    });

    client.on('authenticated', () => {
        addLog('✅ Authentication successful!', 'success');
    });

    client.on('auth_failure', (msg) => {
        isConnected = false;
        addLog('❌ Auth failed: ' + msg, 'error');
        io.emit('connected', false);
    });

    client.on('disconnected', (reason) => {
        isConnected = false;
        addLog('❌ Disconnected: ' + reason, 'error');
        io.emit('connected', false);
        setTimeout(() => {
            if (!isConnected) {
                addLog('Reconnecting...', 'warning');
                client.initialize();
            }
        }, 5000);
    });

    client.on('message', async (message) => {
        addLog(`📩 New message from ${message.from}: ${message.body.substring(0, 50)}`, 'info');
        // Auto-reply feature (optional)
        if (message.body.toLowerCase() === '!ping') {
            await message.reply('pong! 🏓');
        }
    });

    return client;
}

async function sendStartupNotification() {
    try {
        const adminNumber = process.env.ADMIN_NUMBER || '';
        if (adminNumber) {
            await client.sendMessage(`${adminNumber}@c.us`, '🤖 WhatsApp Bot is now online and ready!');
        }
    } catch(e) {}
}

// ============ API ENDPOINTS (Graph API Style) ============
app.use(express.json());

// Status API
app.get('/api/v1/status', (req, res) => {
    res.json({
        status: isConnected ? 'connected' : 'disconnected',
        sending: isSending,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Stats API
app.get('/api/v1/stats', (req, res) => {
    const stats = JSON.parse(fs.readFileSync(statsFile));
    res.json(stats);
});

// Groups API
app.get('/api/v1/groups', async (req, res) => {
    if (!client || !isConnected) {
        return res.status(503).json({ error: 'WhatsApp not connected', groups: [] });
    }
    try {
        const chats = await client.getChats();
        const groups = chats.filter(chat => chat.isGroup).map(g => ({
            id: g.id._serialized,
            name: g.name,
            members: g.participants.length,
            createdAt: g.createdAt
        }));
        res.json({ success: true, count: groups.length, groups });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Send Message API
app.post('/api/v1/send', async (req, res) => {
    const { to, message, delay } = req.body;
    
    if (!client || !isConnected) {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    
    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message" field' });
    }
    
    try {
        if (delay) await new Promise(r => setTimeout(r, delay * 1000));
        
        let chatId = to.includes('@') ? to : `${to}@c.us`;
        const result = await client.sendMessage(chatId, message);
        
        res.json({ success: true, messageId: result.id.id, to: chatId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Bulk Send API
app.post('/api/v1/bulk-send', async (req, res) => {
    const { targets, message, delay, cycles } = req.body;
    
    if (!client || !isConnected) {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    
    let targetsList = Array.isArray(targets) ? targets : [targets];
    let totalSent = 0;
    
    res.json({ success: true, message: 'Bulk send started', totalTargets: targetsList.length });
    
    // Process in background
    (async () => {
        for (let cycle = 0; cycle < (cycles || 1); cycle++) {
            for (const target of targetsList) {
                if (!target.trim()) continue;
                try {
                    let chatId = target.includes('@') ? target : `${target}@c.us`;
                    await client.sendMessage(chatId, message);
                    totalSent++;
                    addLog(`Bulk: Sent to ${target}`, 'success');
                    if (delay) await new Promise(r => setTimeout(r, delay * 1000));
                } catch(e) {
                    addLog(`Bulk failed: ${target} - ${e.message}`, 'error');
                }
            }
        }
        addLog(`Bulk send completed! Total sent: ${totalSent}`, 'success');
        saveStats(totalSent);
    })();
});

// Get chats API
app.get('/api/v1/chats', async (req, res) => {
    if (!client || !isConnected) {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    try {
        const chats = await client.getChats();
        const simplified = chats.slice(0, 50).map(c => ({
            id: c.id._serialized,
            name: c.name || c.id.user,
            isGroup: c.isGroup,
            unreadCount: c.unreadCount
        }));
        res.json({ success: true, chats: simplified });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============ SOCKET.IO EVENTS ============
io.on('connection', (socket) => {
    addLog(`New client connected: ${socket.id}`, 'info');
    
    socket.on('getPairingCode', async (number) => {
        try {
            if (!client) {
                initializeClient();
                await client.initialize();
                await new Promise(r => setTimeout(r, 3000));
            }
            const code = await client.requestPairingCode(number);
            io.emit('pairingCode', code);
            addLog(`Pairing code for ${number}: ${code}`, 'success');
        } catch (error) {
            addLog(`Pairing error: ${error.message}`, 'error');
            socket.emit('error', error.message);
        }
    });
    
    socket.on('connectDevice', async () => {
        try {
            if (!client) {
                initializeClient();
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
                addLog('Not connected! First connect WhatsApp', 'error');
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
            addLog(`Groups error: ${error.message}`, 'error');
        }
    });
    
    socket.on('startSending', async (data) => {
        if (isSending) {
            addLog('Already sending! Wait or stop first', 'warning');
            return;
        }
        
        isSending = true;
        let targets = data.targetType === 'number' ? data.targets.split('\n').filter(t => t.trim()) : [data.groupId];
        let totalSent = 0;
        let cycleCount = 0;
        let cycles = data.cycles;
        
        addLog(`Started sending to ${targets.length} targets`, 'success');
        
        while (cycles === -1 || cycleCount < cycles) {
            if (!isSending) break;
            cycleCount++;
            addLog(`Cycle ${cycleCount} of ${cycles === -1 ? '∞' : cycles}`, 'info');
            
            for (let i = 0; i < targets.length; i++) {
                if (!isSending) break;
                const target = targets[i].trim();
                if (target) {
                    try {
                        await new Promise(r => setTimeout(r, data.delay * 1000));
                        let chatId = target.includes('@') ? target : `${target}@c.us`;
                        await client.sendMessage(chatId, data.messageText);
                        totalSent++;
                        addLog(`✅ Sent to ${target}`, 'success');
                        socket.emit('progress', { current: i + 1, total: targets.length, sent: totalSent });
                    } catch (err) {
                        addLog(`❌ Failed to ${target}: ${err.message}`, 'error');
                    }
                }
            }
        }
        
        io.emit('completed', { totalSent, cycles: cycleCount });
        addLog(`✅ Completed! Total sent: ${totalSent} messages`, 'success');
        saveStats(totalSent);
        isSending = false;
    });
    
    socket.on('stopSending', () => {
        isSending = false;
        addLog('⏹️ Stopped by user', 'warning');
    });
    
    socket.on('disconnect', () => {
        addLog(`Client disconnected: ${socket.id}`, 'info');
    });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    addLog(`🚀 Server running on port ${PORT}`, 'success');
    console.log(`\n📱 Open: http://localhost:${PORT}`);
    console.log(`🌐 API: http://localhost:${PORT}/api/v1/status\n`);
});

// Auto-start WhatsApp client
initializeClient();
client.initialize();

// Graceful shutdown
process.on('SIGINT', async () => {
    addLog('Shutting down...', 'warning');
    if (client) await client.destroy();
    process.exit(0);
});
