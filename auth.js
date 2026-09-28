import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, setPersistence, browserLocalPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";

// Attempt to load firebaseConfig from an optional, non-committed module `private-config.js`.
// This reduces exposure in the committed repo. Note: anything sent to the browser
// can still be inspected by an end user; for true secrecy store secrets on a server.
const PERSIST_STORAGE_KEY = 'xhero-persist-allow';

// Small helpers that show/hide the existing loading overlay. Prefer the
// app-provided functions when available (app.js exposes a loader), otherwise
// toggle the DOM directly so the UI still shows during auth operations.
function showLoaderUI(text) {
    try {
        if (typeof window.showLoader === 'function') {
            window.showLoader(text || 'Processing...');
            return;
        }
    } catch (e) { /* ignore */ }
    const overlay = document.getElementById('loading-overlay');
    if (!overlay) return;
    overlay.classList.add('active');
    const t = overlay.querySelector('.loader-text');
    if (t && text) t.textContent = text;
    const progressBar = overlay.querySelector('.progress-bar');
    if (progressBar) {
        progressBar.style.transition = 'width 200ms linear';
        progressBar.style.width = '30%';
    }
}

function hideLoaderUI() {
    try {
        if (typeof window.hideLoader === 'function') {
            window.hideLoader();
            return;
        }
    } catch (e) { /* ignore */ }
    const overlay = document.getElementById('loading-overlay');
    if (!overlay) return;
    const progressBar = overlay.querySelector('.progress-bar');
    if (progressBar) {
        progressBar.style.transition = 'width 450ms ease-in-out';
        progressBar.style.width = '100%';
    }
    setTimeout(() => overlay.classList.remove('active'), 520);
}

// No local dev bypass — keep authentication using Firebase only.
async function initFirebase() {
    let firebaseConfig = null;
    try {
        // try dynamic import of ./private-config.js which should export `firebaseConfig`
        const mod = await import('./private-config.js');
        if (mod && mod.firebaseConfig) {
            firebaseConfig = mod.firebaseConfig;
            console.debug('Loaded firebaseConfig from private-config.js');
        }
    } catch (e) {
        // ignore; private-config.js may not exist in this environment
    }

    if (!firebaseConfig) {
        // Fallback: use a minimal placeholder to avoid breaking local dev.
        // IMPORTANT: Replace this fallback by creating a `private-config.js` file
        // and keeping it out of version control. See README notes.
        firebaseConfig = {
            apiKey: "AIzaSyBW-wYAUqxkAHnfdU1ZdKr2vDcrlB9wJu0",
            authDomain: "xhero-panel.firebaseapp.com",
            databaseURL: "https://xhero-panel-default-rtdb.firebaseio.com",
            projectId: "xhero-panel",
            storageBucket: "xhero-panel.appspot.com",
            messagingSenderId: "884739188583",
            appId: "1:884739188583:web:0694c48bf1a3e7639d31c2",
            measurementId: "G-YY1PT87HYE"
        };
        console.warn('Using embedded firebaseConfig fallback. For better security create a non-committed private-config.js');
    }

    const app = initializeApp(firebaseConfig);
    return getAuth(app);
}

const authPromise = initFirebase();
// expose for other scripts to await initialization
window.__xheroAuthPromise = authPromise;

// --- Page-specific Logic ---
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');

    if (loginForm) {
    const errorElement = document.getElementById('login-error');

    // (dev bypass removed) continue with Firebase-only auth wiring

    // Central auth state handler: when auth changes, call into the app's handlers if present.
    authPromise.then((auth) => {
        onAuthStateChanged(auth, (user) => {
            try {
                if (user) {
                    if (typeof window.handleAuthSignIn === 'function') {
                        window.handleAuthSignIn(user);
                    } else {
                        // app hasn't defined its handlers yet — stash pending user
                        window.__pendingAuthUser = user;
                    }
                } else {
                    if (typeof window.handleAuthSignOut === 'function') {
                        window.handleAuthSignOut();
                    } else {
                        // stash pending sign-out
                        window.__pendingAuthSignedOut = true;
                    }
                }
            } catch (e) { /* swallow */ }
        });
    }).catch(() => { /* ignore init errors */ });

        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const rememberMe = document.getElementById('login-remember')?.checked || false;

            try {
                // show loader while authentication is in progress
                showLoaderUI('Signing in...');

                // Failsafe: hide loader after 15s if nothing else does
                let loaderTimeout = setTimeout(() => { hideLoaderUI(); }, 15000);

                const auth = await authPromise; // Ensure auth is retrieved from authPromise
                // Set persistence based on remember me checkbox
                await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
                if (rememberMe) localStorage.setItem(PERSIST_STORAGE_KEY, '1'); else localStorage.removeItem(PERSIST_STORAGE_KEY);

                await signInWithEmailAndPassword(auth, email, password);
                // onAuthStateChanged will trigger the app handler; app.js will hide the loader
                clearTimeout(loaderTimeout);
            } catch (error) {
                clearTimeout(loaderTimeout);
                hideLoaderUI();
                errorElement.textContent = 'Invalid email or password.';
            }
        });

} else if (registerForm) {
    const errorElement = document.getElementById('register-error');
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        try {
            const auth = await authPromise;
            await createUserWithEmailAndPassword(auth, email, password);
            window.location.href = 'index.html';
        } catch (error) {
            if (error.code === 'auth/email-already-in-use') {
                errorElement.textContent = 'This email is already in use.';
            } else {
                errorElement.textContent = 'Error creating account.';
            }
        }
    });

    // (no auto-submit) If URL contains ?email=...&password=..., auto-fill the form fields only
    try {
        const params = new URLSearchParams(window.location.search || '');
        const preEmail = params.get('email');
        const prePassword = params.get('password');
        if (preEmail) {
            const emailInput = document.getElementById('email');
            if (emailInput) emailInput.value = decodeURIComponent(preEmail);
        }
        if (prePassword) {
            const passwordInput = document.getElementById('password');
            if (passwordInput) passwordInput.value = decodeURIComponent(prePassword);
        }
    } catch (e) { /* swallow */ }
}
