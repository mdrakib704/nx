// --- ADMIN PANEL CONTROLLER ---
// Dynamically builds and handles the Admin View to avoid cluttering index.html

function initAdminView() {
    let adminView = document.getElementById('view-admin');
    
    // Inject HTML on first load
    if (!adminView) {
        adminView = document.createElement('section');
        adminView.id = 'view-admin';
        adminView.className = 'view';
        
        adminView.innerHTML = `
            <header>
                <h1>Admin Control Panel</h1>
                <button class="btn primary" onclick="loadAdminDashboard()">Refresh Data</button>
            </header>

            <div class="stats-grid" id="admin-stats-grid" style="margin-bottom: 2rem;">
                <!-- Stats injected here -->
            </div>

            <div class="manage-grid" style="height: auto;">
                <!-- Users Panel -->
                <div class="glass-panel" style="padding: 1.5rem;">
                    <h3>User Management</h3>
                    <div style="overflow-x:auto; margin-top:1rem;">
                        <table style="width:100%; text-align:left; border-collapse:collapse;">
                            <thead>
                                <tr style="border-bottom: 1px solid var(--glass-border);">
                                    <th style="padding:0.5rem;">ID</th>
                                    <th style="padding:0.5rem;">Username</th>
                                    <th style="padding:0.5rem;">Email</th>
                                    <th style="padding:0.5rem;">Role</th>
                                    <th style="padding:0.5rem;">Coins</th>
                                </tr>
                            </thead>
                            <tbody id="admin-users-list">
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- System & Background Panel -->
                <div class="glass-panel" style="padding: 1.5rem; display:flex; flex-direction:column; gap:1.5rem;">
                    <div>
                        <h3>Background Manager</h3>
                        <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:1rem;">Upload MP4/WebM or Images.</p>
                        <input type="file" id="admin-bg-upload" accept="video/mp4, video/webm, image/png, image/jpeg" style="margin-bottom:0.5rem;">
                        <button class="btn success" onclick="uploadAdminBackground()" style="width:100%;">Upload Background</button>
                    </div>

                    <div style="border-top: 1px solid var(--glass-border); padding-top:1rem;">
                        <h3>Ad Manager</h3>
                        <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:1rem;">Modify SQLite database to schedule robust ads. Core engine reads active ads automatically.</p>
                        <button class="btn outline" style="width:100%; cursor:not-allowed;" disabled>Manage Ads (DB only)</button>
                    </div>
                </div>
            </div>
        `;
        document.querySelector('.content-area').appendChild(adminView);
    }
    
    loadAdminDashboard();
}

async function loadAdminDashboard() {
    try {
        // Fetch Stats
        const stats = await apiCall('/admin/stats');
        const statsGrid = document.getElementById('admin-stats-grid');
        statsGrid.innerHTML = `
            <div class="stat-card glass-panel">
                <h3>Total Users</h3>
                <p>${stats.users}</p>
            </div>
            <div class="stat-card glass-panel">
                <h3>Total Servers</h3>
                <p>${stats.servers}</p>
            </div>
            <div class="stat-card glass-panel">
                <h3>Online Nodes</h3>
                <p>${stats.activeServers}</p>
            </div>
            <div class="stat-card glass-panel" style="border: 1px solid var(--accent);">
                <h3>Panel RAM Usage</h3>
                <p style="color: var(--accent);">${stats.panelMemory}</p>
            </div>
        `;

        // Fetch Users
        const users = await apiCall('/admin/users');
        const usersList = document.getElementById('admin-users-list');
        usersList.innerHTML = '';
        users.forEach(u => {
            usersList.innerHTML += `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding:0.5rem;">#${u.id}</td>
                    <td style="padding:0.5rem;">${escapeHtml(u.username)}</td>
                    <td style="padding:0.5rem;">${escapeHtml(u.email)}</td>
                    <td style="padding:0.5rem;">
                        <span style="padding:0.2rem 0.5rem; border-radius:4px; font-size:0.8rem; background:${u.role==='admin'?'var(--danger)':'var(--success)'};">${u.role.toUpperCase()}</span>
                    </td>
                    <td style="padding:0.5rem;">${u.coins}</td>
                </tr>
            `;
        });
    } catch (e) {
        alert("Admin load error: " + e.message);
    }
}

async function uploadAdminBackground() {
    const input = document.getElementById('admin-bg-upload');
    if (!input.files.length) return alert('Select a file first.');

    const formData = new FormData();
    formData.append('file', input.files[0]);

    try {
        await apiCall('/admin/backgrounds', 'POST', formData, true);
        alert('Background uploaded! You must activate it in the database.');
        input.value = '';
    } catch (e) {
        alert(e.message);
    }
}
