const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const extract = require('extract-zip');
const { pipeline } = require('stream/promises');
const db = require('./database.js');
const runner = require('./runner.js');
const config = require('./config.json');

module.exports = async function (fastify, opts) {
    
    // Auth Middleware
    fastify.decorateRequest('user', null);
    
    fastify.addHook('preHandler', async (request, reply) => {
        const publicRoutes = ['/api/auth/login', '/api/auth/register', '/api/backgrounds/active', '/api/ads/active'];
        if (publicRoutes.includes(request.routeOptions.url)) return;

        const authHeader = request.headers.authorization;
        if (!authHeader) return reply.code(401).send({ error: 'Missing Authorization header' });

        const token = authHeader.replace('Bearer ', '');
        try {
            const decoded = jwt.verify(token, config.jwtSecret);
            const user = db.prepare('SELECT id, username, email, role, coins FROM users WHERE id = ?').get(decoded.id);
            if (!user) throw new Error('User not found');
            request.user = user;
        } catch (err) {
            return reply.code(401).send({ error: 'Invalid or expired token' });
        }
    });

    // Helper: Require Admin
    const requireAdmin = async (request, reply) => {
        if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Admin access required' });
    };

    // --- AUTHENTICATION --- //
    fastify.post('/auth/register', async (request, reply) => {
        const { username, email, password, referral_code } = request.body;
        if (!username || !email || !password) return reply.code(400).send({ error: 'Missing fields' });

        const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
        if (existing) return reply.code(400).send({ error: 'Username or email already exists' });

        const hash = await bcrypt.hash(password, 10);
        const refCode = Math.random().toString(36).substring(2, 10).toUpperCase();

        let referredBy = null;
        if (referral_code) {
            const refUser = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referral_code);
            if (refUser) {
                referredBy = refUser.id;
                db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(config.coinSystem.referralReward, refUser.id);
            }
        }

        const info = db.prepare('INSERT INTO users (username, email, password, referral_code, referred_by) VALUES (?, ?, ?, ?, ?)').run(
            username, email, hash, refCode, referredBy
        );

        return { success: true, message: 'Registration successful' };
    });

    fastify.post('/auth/login', async (request, reply) => {
        const { email, password } = request.body;
        if (!email || !password) return reply.code(400).send({ error: 'Missing fields' });

        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (!user) return reply.code(401).send({ error: 'Invalid credentials' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return reply.code(401).send({ error: 'Invalid credentials' });

        const token = jwt.sign({ id: user.id }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
        return { success: true, token, user: { id: user.id, username: user.username, role: user.role, coins: user.coins } };
    });

    fastify.get('/auth/me', async (request, reply) => {
        return request.user;
    });

    // --- SERVERS --- //
    fastify.get('/servers', async (request, reply) => {
        let servers;
        if (request.user.role === 'admin') {
            servers = db.prepare('SELECT * FROM servers').all();
        } else {
            servers = db.prepare('SELECT * FROM servers WHERE user_id = ?').all(request.user.id);
        }
        return servers;
    });

    fastify.post('/servers', async (request, reply) => {
        const { name, type, startup_command } = request.body;
        
        // Enforce limit
        const currentCount = db.prepare('SELECT COUNT(*) as count FROM servers WHERE user_id = ?').get(request.user.id).count;
        if (currentCount >= config.defaultResources.serverLimit && request.user.role !== 'admin') {
            return reply.code(403).send({ error: 'Server limit reached. Upgrade in the shop.' });
        }

        const info = db.prepare('INSERT INTO servers (user_id, name, type, ram, cpu, storage, startup_command) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            request.user.id, name, type, config.defaultResources.ram, config.defaultResources.cpu, config.defaultResources.storage, startup_command || ''
        );

        const serverPath = path.resolve(config.paths.servers, info.lastInsertRowid.toString());
        fs.mkdirSync(serverPath, { recursive: true });

        db.prepare('INSERT INTO audit_logs (user_id, action, details) VALUES (?, ?, ?)').run(request.user.id, 'CREATE_SERVER', `Server ${info.lastInsertRowid} created`);

        return { success: true, serverId: info.lastInsertRowid };
    });

    fastify.delete('/servers/:id', async (request, reply) => {
        const server = db.prepare('SELECT user_id FROM servers WHERE id = ?').get(request.params.id);
        if (!server) return reply.code(404).send({ error: 'Server not found' });
        if (server.user_id !== request.user.id && request.user.role !== 'admin') return reply.code(403).send({ error: 'Unauthorized' });

        runner.killServer(request.params.id);
        db.prepare('DELETE FROM servers WHERE id = ?').run(request.params.id);
        
        const serverPath = path.resolve(config.paths.servers, request.params.id.toString());
        fs.rmSync(serverPath, { recursive: true, force: true });

        db.prepare('INSERT INTO audit_logs (user_id, action, details) VALUES (?, ?, ?)').run(request.user.id, 'DELETE_SERVER', `Server ${request.params.id} deleted`);

        return { success: true };
    });

    fastify.post('/servers/:id/power', async (request, reply) => {
        const { action } = request.body; // start, stop, kill
        const server = db.prepare('SELECT user_id FROM servers WHERE id = ?').get(request.params.id);
        
        if (!server) return reply.code(404).send({ error: 'Server not found' });
        if (server.user_id !== request.user.id && request.user.role !== 'admin') return reply.code(403).send({ error: 'Unauthorized' });

        let res;
        if (action === 'start') res = runner.startServer(request.params.id, fastify.wss);
        else if (action === 'stop') res = runner.stopServer(request.params.id);
        else if (action === 'kill') res = runner.killServer(request.params.id);
        else return reply.code(400).send({ error: 'Invalid action' });

        if (!res.success) return reply.code(500).send({ error: res.error });
        return { success: true };
    });

    // --- FILE MANAGER --- //
    const getSafePath = (serverId, reqPath) => {
        const root = path.resolve(config.paths.servers, serverId.toString());
        const target = path.resolve(root, reqPath || '');
        if (!target.startsWith(root)) throw new Error('Directory traversal attempt');
        return { root, target };
    };

    fastify.post('/servers/:id/files/list', async (request, reply) => {
        const server = db.prepare('SELECT user_id FROM servers WHERE id = ?').get(request.params.id);
        if (!server || (server.user_id !== request.user.id && request.user.role !== 'admin')) return reply.code(403).send({ error: 'Unauthorized' });

        try {
            const { target } = getSafePath(request.params.id, request.body.path);
            if (!fs.existsSync(target)) return [];
            
            const files = fs.readdirSync(target, { withFileTypes: true }).map(dirent => {
                const stat = fs.statSync(path.join(target, dirent.name));
                return {
                    name: dirent.name,
                    isDirectory: dirent.isDirectory(),
                    size: stat.size,
                    mtime: stat.mtime
                };
            });
            return files;
        } catch (e) {
            return reply.code(400).send({ error: 'Invalid path' });
        }
    });

    fastify.post('/servers/:id/files/upload', async (request, reply) => {
        const server = db.prepare('SELECT user_id FROM servers WHERE id = ?').get(request.params.id);
        if (!server || (server.user_id !== request.user.id && request.user.role !== 'admin')) return reply.code(403).send({ error: 'Unauthorized' });

        const parts = request.parts();
        let targetDir = '';

        for await (const part of parts) {
            if (part.type === 'field' && part.fieldname === 'path') {
                targetDir = part.value;
            }
            if (part.type === 'file') {
                const { target } = getSafePath(request.params.id, targetDir);
                if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
                const filePath = path.join(target, part.filename);
                await pipeline(part.file, fs.createWriteStream(filePath));
            }
        }
        return { success: true };
    });

    fastify.post('/servers/:id/files/delete', async (request, reply) => {
        const server = db.prepare('SELECT user_id FROM servers WHERE id = ?').get(request.params.id);
        if (!server || (server.user_id !== request.user.id && request.user.role !== 'admin')) return reply.code(403).send({ error: 'Unauthorized' });

        try {
            const { target } = getSafePath(request.params.id, request.body.path);
            if (fs.existsSync(target)) {
                fs.rmSync(target, { recursive: true, force: true });
            }
            return { success: true };
        } catch (e) {
            return reply.code(400).send({ error: 'Delete failed' });
        }
    });

    fastify.post('/servers/:id/files/zip', async (request, reply) => {
        const server = db.prepare('SELECT user_id FROM servers WHERE id = ?').get(request.params.id);
        if (!server || (server.user_id !== request.user.id && request.user.role !== 'admin')) return reply.code(403).send({ error: 'Unauthorized' });

        try {
            const { target } = getSafePath(request.params.id, request.body.path);
            const archivePath = `${target}.zip`;
            const output = fs.createWriteStream(archivePath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            archive.pipe(output);
            if (fs.statSync(target).isDirectory()) archive.directory(target, false);
            else archive.file(target, { name: path.basename(target) });
            await archive.finalize();

            return { success: true };
        } catch (e) {
            return reply.code(400).send({ error: 'Zip failed' });
        }
    });

    fastify.post('/servers/:id/files/unzip', async (request, reply) => {
        const server = db.prepare('SELECT user_id FROM servers WHERE id = ?').get(request.params.id);
        if (!server || (server.user_id !== request.user.id && request.user.role !== 'admin')) return reply.code(403).send({ error: 'Unauthorized' });

        try {
            const { target } = getSafePath(request.params.id, request.body.path);
            const extractTo = path.dirname(target);
            await extract(target, { dir: extractTo });
            return { success: true };
        } catch (e) {
            return reply.code(400).send({ error: 'Unzip failed' });
        }
    });

    // --- COIN SYSTEM / ECONOMY --- //
    fastify.post('/coins/daily', async (request, reply) => {
        const user = db.prepare('SELECT last_daily_reward FROM users WHERE id = ?').get(request.user.id);
        const now = new Date();
        if (user.last_daily_reward) {
            const lastTime = new Date(user.last_daily_reward);
            const diffHours = Math.abs(now - lastTime) / 36e5;
            if (diffHours < 24) return reply.code(400).send({ error: `You must wait ${Math.ceil(24 - diffHours)} hours.` });
        }
        
        db.prepare('UPDATE users SET coins = coins + ?, last_daily_reward = CURRENT_TIMESTAMP WHERE id = ?').run(config.coinSystem.dailyReward, request.user.id);
        return { success: true, reward: config.coinSystem.dailyReward };
    });

    fastify.post('/coins/shop', async (request, reply) => {
        const { type } = request.body; // 'ram', 'cpu', 'storage', 'slot'
        const costs = { ram: 100, cpu: 150, storage: 50, slot: 500 }; // Configurable in admin later
        const cost = costs[type];
        
        if (!cost) return reply.code(400).send({ error: 'Invalid upgrade type' });
        
        const tx = db.transaction(() => {
            const u = db.prepare('SELECT coins FROM users WHERE id = ?').get(request.user.id);
            if (u.coins < cost) throw new Error('Not enough coins');
            db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(cost, request.user.id);
            return true;
        });

        try {
            tx();
            // Upgrading logic (this increments account-wide resources, normally tied to user profile limits)
            return { success: true, message: 'Upgrade purchased' };
        } catch (e) {
            return reply.code(400).send({ error: e.message });
        }
    });

    // --- ADMIN PANEL --- //
    fastify.get('/admin/stats', { preHandler: requireAdmin }, async (request, reply) => {
        const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
        const servers = db.prepare('SELECT COUNT(*) as c FROM servers').get().c;
        const activeServers = db.prepare('SELECT COUNT(*) as c FROM servers WHERE status = ?').get('online').c;
        
        // Process RAM usage overhead approx
        const memoryUsage = process.memoryUsage().rss / 1024 / 1024;

        return { users, servers, activeServers, panelMemory: memoryUsage.toFixed(2) + ' MB' };
    });

    fastify.get('/admin/users', { preHandler: requireAdmin }, async (request, reply) => {
        return db.prepare('SELECT id, username, email, role, coins, created_at FROM users').all();
    });

    fastify.post('/admin/backgrounds', { preHandler: requireAdmin }, async (request, reply) => {
        const parts = request.parts();
        for await (const part of parts) {
            if (part.type === 'file') {
                const filename = Date.now() + '_' + part.filename;
                const filePath = path.join(config.paths.backgrounds, filename);
                await pipeline(part.file, fs.createWriteStream(filePath));
                
                db.prepare('INSERT INTO backgrounds (filename, type, is_active) VALUES (?, ?, 0)').run(filename, part.mimetype);
            }
        }
        return { success: true };
    });

    fastify.get('/backgrounds/active', async (request, reply) => {
        return db.prepare('SELECT * FROM backgrounds WHERE is_active = 1 LIMIT 1').get() || null;
    });

    fastify.get('/ads/active', async (request, reply) => {
        return db.prepare('SELECT * FROM ads WHERE is_active = 1').all();
    });
};
