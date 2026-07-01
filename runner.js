const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const db = require('./database.js');

const processes = new Map();
const serverLogs = new Map(); // Store tail of logs

function getStartCommand(type, serverPath, customCmd, ram) {
    if (customCmd && customCmd.trim() !== '') {
        return customCmd.split(' ');
    }
    switch (type) {
        case 'minecraft_java':
            return ['java', `-Xmx${ram}M`, `-Xms${ram}M`, '-jar', 'server.jar', 'nogui'];
        case 'minecraft_bedrock':
            return [process.platform === 'win32' ? 'bedrock_server.exe' : './bedrock_server'];
        case 'nodejs':
        case 'discord_bot':
            return ['node', `--max-old-space-size=${ram}`, 'index.js'];
        case 'python':
            return ['python3', 'main.py'];
        case 'php':
            return ['php', '-S', '0.0.0.0:8000', '-t', 'public'];
        case 'java':
            return ['java', `-Xmx${ram}M`, '-jar', 'app.jar'];
        case 'bun':
            return ['bun', 'run', 'index.ts'];
        case 'deno':
            return ['deno', 'run', '--allow-all', 'main.ts'];
        default:
            return null;
    }
}

function startServer(serverId, wss) {
    if (processes.has(serverId)) return { success: false, error: 'Server is already running.' };

    const serverData = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!serverData) return { success: false, error: 'Server not found.' };

    const serverPath = path.resolve(config.paths.servers, serverId.toString());
    if (!fs.existsSync(serverPath)) fs.mkdirSync(serverPath, { recursive: true });

    const cmdArray = getStartCommand(serverData.type, serverPath, serverData.startup_command, serverData.ram);
    if (!cmdArray || cmdArray.length === 0) return { success: false, error: 'Invalid startup configuration.' };

    const command = cmdArray.shift();
    const args = cmdArray;
    let envObj = process.env;
    
    try {
        if (serverData.env_vars) {
            envObj = { ...process.env, ...JSON.parse(serverData.env_vars) };
        }
    } catch (e) {
        console.error(`[Runner] Server ${serverId} has invalid env_vars JSON.`);
    }

    try {
        const child = spawn(command, args, {
            cwd: serverPath,
            env: envObj
        });

        processes.set(serverId, child);
        serverLogs.set(serverId, []);
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('online', serverId);
        broadcastStatus(wss, serverId, 'online');

        const handleLog = (data) => {
            const lines = data.toString().split('\n').filter(l => l.trim() !== '');
            const logs = serverLogs.get(serverId);
            lines.forEach(line => {
                logs.push(line);
                if (logs.length > 200) logs.shift(); // Keep last 200 lines
                broadcastConsole(wss, serverId, line);
            });
        };

        child.stdout.on('data', handleLog);
        child.stderr.on('data', handleLog);

        child.on('close', (code) => {
            processes.delete(serverId);
            db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('offline', serverId);
            broadcastStatus(wss, serverId, 'offline');
            broadcastConsole(wss, serverId, `[NX Panel] Server stopped with code ${code}`);
        });

        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function stopServer(serverId) {
    const child = processes.get(serverId);
    if (!child) return { success: false, error: 'Server not running.' };
    child.kill('SIGTERM');
    return { success: true };
}

function killServer(serverId) {
    const child = processes.get(serverId);
    if (!child) return { success: false, error: 'Server not running.' };
    child.kill('SIGKILL');
    return { success: true };
}

function sendCommand(serverId, command) {
    const child = processes.get(serverId);
    if (!child) return { success: false, error: 'Server not running.' };
    child.stdin.write(command + '\n');
    return { success: true };
}

function getServerLogs(serverId) {
    return serverLogs.get(serverId) || [];
}

// WebSocket broadcasting helpers
function broadcastStatus(wss, serverId, status) {
    if (!wss) return;
    wss.clients.forEach(client => {
        if (client.serverId === serverId && client.readyState === 1 /* WebSocket.OPEN */) {
            client.send(JSON.stringify({ event: 'status', status }));
        }
    });
}

function broadcastConsole(wss, serverId, message) {
    if (!wss) return;
    wss.clients.forEach(client => {
        if (client.serverId === serverId && client.readyState === 1) {
            client.send(JSON.stringify({ event: 'console', data: message }));
        }
    });
}

module.exports = { startServer, stopServer, killServer, sendCommand, getServerLogs, processes };
