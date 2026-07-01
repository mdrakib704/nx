const Fastify = require('fastify');
const path = require('path');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const config = require('./config.json');

const app = Fastify({ logger: false, bodyLimit: 104857600 }); // 100MB body limit

// Register plugins
app.register(require('@fastify/cors'), { origin: '*' });
app.register(require('@fastify/multipart'), { limits: { fileSize: 1024 * 1024 * 1024 } }); // 1GB file upload limit
app.register(require('@fastify/static'), {
    root: path.join(__dirname, 'public'),
    prefix: '/'
});

// Setup WebSocket Server
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // Initial Auth & Subscription
            if (data.event === 'auth') {
                jwt.verify(data.token, config.jwtSecret, (err, decoded) => {
                    if (err) return ws.close();
                    ws.user = decoded;
                    ws.serverId = data.serverId; // Subscribe to specific server console
                    ws.send(JSON.stringify({ event: 'auth_success' }));
                    
                    // Send log history if serverId is provided
                    if (data.serverId) {
                        const { getServerLogs } = require('./runner.js');
                        const history = getServerLogs(data.serverId);
                        history.forEach(line => ws.send(JSON.stringify({ event: 'console', data: line })));
                    }
                });
            }
            
            // Console Input
            if (data.event === 'command' && ws.user && ws.serverId) {
                const { sendCommand } = require('./runner.js');
                // Ensure user owns server or is admin
                const db = require('./database.js');
                const server = db.prepare('SELECT user_id FROM servers WHERE id = ?').get(ws.serverId);
                if (server && (server.user_id === ws.user.id || ws.user.role === 'admin')) {
                    sendCommand(ws.serverId, data.command);
                }
            }
        } catch (e) {
            console.error('[WS] Error processing message', e);
        }
    });
});

// Export wss so API routes can trigger broadcasts
app.decorate('wss', wss);

// Register API Routes
app.register(require('./api.js'), { prefix: '/api' });

// Catch-all to serve index.html for SPA frontend routing
app.setNotFoundHandler((request, reply) => {
    reply.sendFile('index.html');
});

// Start Server & Handle WS Upgrade
const start = async () => {
    try {
        await app.listen({ port: config.port, host: '0.0.0.0' });
        
        app.server.on('upgrade', (request, socket, head) => {
            if (request.url.startsWith('/ws')) {
                wss.handleUpgrade(request, socket, head, (ws) => {
                    wss.emit('connection', ws, request);
                });
            } else {
                socket.destroy();
            }
        });

        console.log(`[NX Panel] Started on http://0.0.0.0:${config.port}`);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

start();
