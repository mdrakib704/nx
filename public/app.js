// --- GLOBAL STATE ---
let state = {
    token: localStorage.getItem('nx_token') || null,
    user: null,
    servers: [],
    activeServerId: null,
    currentFilePath: '',
    ws: null
};

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    initBackground();
    initAds();
    if (state.token) {
        authenticateWithToken();
    } else {
        showAuth();
    }

    // Auth Listeners
    document.getElementById('login-form').addEventListener('submit', handleLogin);
    document.getElementById('register-form').addEventListener('submit', handleRegister);
    
    // Console Input Listener
    document.getElementById('console-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendCommand();
    });
});

// --- API HELPER ---
async function apiCall(endpoint, method = 'GET', body = null, isMultipart = false) {
    const headers = {};
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    if (!isMultipart && body) headers['Content-Type'] = 'application/json';

    const options = { method, headers };
    if (body) options.body = isMultipart ? body : JSON.stringify(body);

    const res = await fetch(`/api${endpoint}`, options);
    const data = await res.json().catch(() => ({}));
    
    if (!res.ok) {
        if (res.status === 401) logout();
        throw new Error(data.error || 'API Request Failed');
    }
    return data;
}

// --- AUTHENTICATION ---
async function authenticateWithToken() {
    try {
        const user = await apiCall('/auth/me');
        state.user = user;
        document.getElementById('dash-username').textContent = user.username;
        document.getElementById('user-coin-balance').textContent = `🪙 ${user.coins} Coins`;
        
        if (user.role === 'admin') {
            document.getElementById('nav-admin').style.display = 'block';
        }

        showApp();
        initWebSocket();
        navigate('dashboard');
    } catch (e) {
        logout();
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    
    try {
        const res = await apiCall('/auth/login', 'POST', { email, password });
        state.token = res.token;
        localStorage.setItem('nx_token', res.token);
        authenticateWithToken();
    } catch (e) {
        alert(e.message);
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const username = document.getElementById('reg-username').value;
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;
    
    try {
        await apiCall('/auth/register', 'POST', { username, email, password });
        alert('Registration successful! Please login.');
        toggleAuth();
    } catch (e) {
        alert(e.message);
    }
}

function logout() {
    state.token = null;
    state.user = null;
    localStorage.removeItem('nx_token');
    if (state.ws) state.ws.close();
    showAuth();
}

function toggleAuth() {
    const login = document.getElementById('login-form');
    const register = document.getElementById('register-form');
    if (login.style.display === 'none') {
        login.style.display = 'block';
        register.style.display = 'none';
    } else {
        login.style.display = 'none';
        register.style.display = 'block';
    }
}

function showAuth() {
    document.getElementById('auth-container').classList.add('active');
    document.getElementById('app-container').style.display = 'none';
}

function showApp() {
    document.getElementById('auth-container').classList.remove('active');
    document.getElementById('app-container').style.display = 'flex';
}

// --- NAVIGATION ---
function navigate(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-links li').forEach(l => l.classList.remove('active'));
    
    // Attempt to activate sidebar link if exists
    const link = Array.from(document.querySelectorAll('.nav-links li')).find(l => l.textContent.toLowerCase().includes(viewId.toLowerCase()));
    if (link) link.classList.add('active');

    if (viewId === 'dashboard') loadDashboard();
    if (viewId === 'servers') loadServers();
    if (viewId === 'admin' && typeof initAdminView === 'function') initAdminView();
    
    const viewEl = document.getElementById(`view-${viewId}`);
    if (viewEl) viewEl.classList.add('active');
}

// --- DASHBOARD ---
async function loadDashboard() {
    try {
        const servers = await apiCall('/servers');
        state.servers = servers;
        
        let totalRam = 0;
        servers.forEach(s => totalRam += s.ram);
        
        document.getElementById('stat-servers').textContent = servers.length;
        document.getElementById('stat-ram').textContent = `${totalRam} MB`;
        document.getElementById('stat-coins').textContent = state.user.coins;
    } catch (e) {
        console.error(e);
    }
}

async function claimDailyReward() {
    try {
        const res = await apiCall('/coins/daily', 'POST');
        alert(`Successfully claimed ${res.reward} coins!`);
        authenticateWithToken(); // Refresh user data
    } catch (e) {
        alert(e.message);
    }
}

// --- SERVERS ---
async function loadServers() {
    try {
        const servers = await apiCall('/servers');
        state.servers = servers;
        const grid = document.getElementById('servers-list');
        grid.innerHTML = '';
        
        if (servers.length === 0) {
            grid.innerHTML = '<p style="color:var(--text-muted);">No servers found. Create one to get started.</p>';
            return;
        }

        servers.forEach(server => {
            const card = document.createElement('div');
            card.className = 'server-card glass-panel';
            card.onclick = () => openServer(server);
            
            const statusClass = server.status === 'online' ? 'status-online' : 'status-offline';
            
            card.innerHTML = `
                <h3><span class="status-indicator ${statusClass}" id="status-ind-${server.id}"></span> ${escapeHtml(server.name)}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem; margin-top:0.5rem;">Type: ${server.type}</p>
                <p style="color:var(--text-muted); font-size:0.9rem;">RAM: ${server.ram} MB | CPU: ${server.cpu}%</p>
            `;
            grid.appendChild(card);
        });
    } catch (e) {
        alert(e.message);
    }
}

function showCreateServerModal() {
    document.getElementById('create-server-modal').classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

async function createServer() {
    const name = document.getElementById('new-server-name').value;
    const type = document.getElementById('new-server-type').value;
    const cmd = document.getElementById('new-server-cmd').value;

    try {
        await apiCall('/servers', 'POST', { name, type, startup_command: cmd });
        closeModal('create-server-modal');
        loadServers();
    } catch (e) {
        alert(e.message);
    }
}

// --- SERVER MANAGEMENT (CONSOLE & POWER) ---
function openServer(server) {
    state.activeServerId = server.id;
    state.currentFilePath = '';
    
    document.getElementById('manage-server-name').textContent = server.name;
    document.getElementById('console-output').innerHTML = ''; // Clear console
    
    // Subscribe WS to this server
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ event: 'auth', token: state.token, serverId: server.id }));
    }

    loadFileBrowser();
    navigate('server-manage');
}

async function serverAction(action) {
    if (!state.activeServerId) return;
    try {
        await apiCall(`/servers/${state.activeServerId}/power`, 'POST', { action });
    } catch (e) {
        alert(e.message);
    }
}

function sendCommand() {
    const input = document.getElementById('console-input');
    const command = input.value.trim();
    if (!command || !state.activeServerId || !state.ws) return;

    state.ws.send(JSON.stringify({ event: 'command', command }));
    input.value = '';
}

// --- FILE MANAGER ---
async function loadFileBrowser() {
    if (!state.activeServerId) return;
    
    try {
        const files = await apiCall(`/servers/${state.activeServerId}/files/list`, 'POST', { path: state.currentFilePath });
        const list = document.getElementById('file-list');
        list.innerHTML = '';

        // Up directory button
        if (state.currentFilePath !== '') {
            const upDiv = document.createElement('div');
            upDiv.className = 'file-item';
            upDiv.innerHTML = `<span style="cursor:pointer;">📁 ..</span>`;
            upDiv.onclick = () => {
                const parts = state.currentFilePath.split('/');
                parts.pop();
                state.currentFilePath = parts.join('/');
                loadFileBrowser();
            };
            list.appendChild(upDiv);
        }

        files.sort((a, b) => b.isDirectory - a.isDirectory || a.name.localeCompare(b.name));

        files.forEach(file => {
            const el = document.createElement('div');
            el.className = 'file-item';
            
            const icon = file.isDirectory ? '📁' : '📄';
            const size = file.isDirectory ? '--' : formatBytes(file.size);
            
            const actions = [];
            actions.push(`<button class="btn danger outline" onclick="deleteFile('${escapeHtml(file.name)}')">Delete</button>`);
            
            if (file.isDirectory) {
                actions.push(`<button class="btn primary outline" onclick="zipFile('${escapeHtml(file.name)}')">Zip</button>`);
            } else if (file.name.endsWith('.zip')) {
                actions.push(`<button class="btn success outline" onclick="unzipFile('${escapeHtml(file.name)}')">Unzip</button>`);
            }

            el.innerHTML = `
                <div style="cursor:${file.isDirectory ? 'pointer' : 'default'}; flex:1;" onclick="${file.isDirectory ? `enterFolder('${escapeHtml(file.name)}')` : ''}">
                    ${icon} ${escapeHtml(file.name)} <span style="color:var(--text-muted);font-size:0.8rem;margin-left:1rem;">${size}</span>
                </div>
                <div style="display:flex;gap:0.5rem;">${actions.join('')}</div>
            `;
            list.appendChild(el);
        });

    } catch (e) {
        document.getElementById('file-list').innerHTML = `<p style="color:var(--danger)">Error loading files: ${e.message}</p>`;
    }
}

function enterFolder(folderName) {
    state.currentFilePath = state.currentFilePath ? `${state.currentFilePath}/${folderName}` : folderName;
    loadFileBrowser();
}

async function uploadFile() {
    const input = document.getElementById('file-upload');
    if (!input.files.length || !state.activeServerId) return;

    const file = input.files[0];
    const formData = new FormData();
    formData.append('path', state.currentFilePath);
    formData.append('file', file);

    try {
        await apiCall(`/servers/${state.activeServerId}/files/upload`, 'POST', formData, true);
        input.value = ''; // reset
        loadFileBrowser();
    } catch (e) {
        alert(e.message);
    }
}

async function deleteFile(fileName) {
    if(!confirm(`Delete ${fileName}?`)) return;
    const target = state.currentFilePath ? `${state.currentFilePath}/${fileName}` : fileName;
    try {
        await apiCall(`/servers/${state.activeServerId}/files/delete`, 'POST', { path: target });
        loadFileBrowser();
    } catch (e) { alert(e.message); }
}

async function zipFile(fileName) {
    const target = state.currentFilePath ? `${state.currentFilePath}/${fileName}` : fileName;
    try {
        await apiCall(`/servers/${state.activeServerId}/files/zip`, 'POST', { path: target });
        loadFileBrowser();
    } catch (e) { alert(e.message); }
}

async function unzipFile(fileName) {
    const target = state.currentFilePath ? `${state.currentFilePath}/${fileName}` : fileName;
    try {
        await apiCall(`/servers/${state.activeServerId}/files/unzip`, 'POST', { path: target });
        loadFileBrowser();
    } catch (e) { alert(e.message); }
}

// --- WEBSOCKETS ---
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    state.ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    state.ws.onopen = () => {
        // Authenticate connection
        state.ws.send(JSON.stringify({ event: 'auth', token: state.token }));
    };

    state.ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);
        
        if (data.event === 'console') {
            const term = document.getElementById('console-output');
            const line = document.createElement('div');
            line.textContent = data.data; // prevents XSS naturally
            term.appendChild(line);
            term.scrollTop = term.scrollHeight; // Auto-scroll
        }
        
        if (data.event === 'status') {
            const ind = document.getElementById(`status-ind-${state.activeServerId}`);
            if (ind) {
                ind.className = `status-indicator status-${data.status}`;
            }
        }
    };

    state.ws.onclose = () => {
        // Reconnect logic
        if (state.token) {
            setTimeout(initWebSocket, 3000);
        }
    };
}

// --- BACKGROUND MANAGER (PUBLIC) ---
async function initBackground() {
    try {
        const bg = await apiCall('/backgrounds/active');
        if (!bg) return;
        
        const container = document.getElementById('dynamic-background');
        const overlay = document.querySelector('.background-overlay');
        
        overlay.style.background = `rgba(0,0,0, ${bg.opacity})`;
        overlay.style.backdropFilter = `blur(${bg.blur}px)`;
        container.style.filter = `brightness(${bg.brightness}%)`;

        if (bg.type.includes('video')) {
            container.innerHTML = `<video autoplay loop muted playsinline style="width:100%; height:100%; object-fit:cover;"><source src="/backgrounds/${bg.filename}" type="${bg.type}"></video>`;
        } else {
            container.style.backgroundImage = `url('/backgrounds/${bg.filename}')`;
        }
    } catch (e) {
        // Silent fail for backgrounds
    }
}

// --- AD MANAGER (PUBLIC) ---
async function initAds() {
    try {
        const ads = await apiCall('/ads/active');
        const container = document.getElementById('ad-container');
        
        ads.forEach(ad => {
            if (ad.type === 'popup') {
                const el = document.createElement('div');
                el.style.cssText = "position:fixed;bottom:20px;right:20px;background:#fff;color:#000;padding:1rem;border-radius:8px;z-index:9999;box-shadow:0 10px 25px rgba(0,0,0,0.5);";
                el.innerHTML = `
                    <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
                        <strong>Sponsor</strong>
                        <button onclick="this.parentElement.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:red;font-weight:bold;">X</button>
                    </div>
                    <div>${ad.content}</div>
                `;
                container.appendChild(el);
            }
        });
    } catch (e) {
        // Silent fail
    }
}

// --- UTILS ---
function escapeHtml(unsafe) {
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024, dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
      }
