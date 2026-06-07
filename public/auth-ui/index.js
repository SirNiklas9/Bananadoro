/**
 * Bananadoro auth client — config-driven, talks to Bananauth over Bearer JWT.
 *
 * It reads GET /auth/config to learn which login methods this deployment
 * exposes, and renders only those. Flip methods on in Bananauth's manifest
 * (auth_methods) and they appear here with no change to this file.
 *
 * Exposes the same surface the page expects: { AuthUI, AuthAPI, AuthState }.
 * Token is stored in localStorage and attached as Authorization: Bearer.
 *
 *   import { AuthUI } from '/auth-ui/index.js';
 *   const auth = await new AuthUI({ onAuthChange: updateUI }).init();
 */

const TOKEN_KEY = 'bk_token';
const LABEL_KEY = 'bk_label';

const getToken = () => localStorage.getItem(TOKEN_KEY) || null;
const setToken = (t) => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

async function api(path, { method = 'GET', body, auth = false } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (auth) { const t = getToken(); if (t) headers['Authorization'] = `Bearer ${t}`; }
    const res = await fetch(`/auth${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
}

// ============ API CLIENT ============
export const AuthAPI = {
    config: () => api('/config').then(r => r.data || { methods: [] }),
    register: (email, username, password) => api('/register', { method: 'POST', body: { email, username, password } }),
    login: (email, password) => api('/login', { method: 'POST', body: { email, password } }),
    session: () => api('/session', { auth: true }),
    logout: () => api('/logout', { method: 'POST', auth: true }),
    passwordForgot: (email) => api('/password/forgot', { method: 'POST', body: { email } }),
    passwordReset: (email, code, password) => api('/password/reset', { method: 'POST', body: { email, code, password } }),
    deleteAccount: () => api('/account', { method: 'DELETE', auth: true }),
};

// ============ STATE ============
export const AuthState = {
    user: null,
    _subs: [],

    token() { return getToken(); },
    isLoggedIn() { return !!this.user; },

    subscribe(fn) { this._subs.push(fn); return () => { this._subs = this._subs.filter(s => s !== fn); }; },
    _notify() { this._subs.forEach(fn => fn(this.user)); },

    async checkAuth() {
        if (!getToken()) { this.user = null; this._notify(); return null; }
        const r = await AuthAPI.session();
        if (r.ok && r.data && r.data.valid) {
            this.user = {
                id: r.data.account_id,
                username: localStorage.getItem(LABEL_KEY) || 'Account',
                provider: localStorage.getItem(LABEL_KEY + '_provider') || 'password',
            };
        } else {
            setToken(null);
            this.user = null;
        }
        this._notify();
        return this.user;
    },

    // Persist the token returned by login/register/oauth and refresh state.
    async adopt(token, label, provider) {
        setToken(token);
        if (label) localStorage.setItem(LABEL_KEY, label);
        if (provider) localStorage.setItem(LABEL_KEY + '_provider', provider);
        return this.checkAuth();
    },

    async logout() {
        try { await AuthAPI.logout(); } catch (_) { /* token already gone is fine */ }
        setToken(null);
        localStorage.removeItem(LABEL_KEY);
        this.user = null;
        this._notify();
    },
};

// ============ UI ============
export class AuthUI {
    constructor(opts = {}) {
        this.onAuthChange = opts.onAuthChange || (() => {});
        this.methods = [];
        this.el = null;
        this.mode = 'login'; // 'login' | 'register'
    }

    hasMethod(m) { return this.methods.includes(m); }

    async init() {
        const cfg = await AuthAPI.config();
        this.methods = Array.isArray(cfg.methods) ? cfg.methods : [];
        this._build();
        AuthState.subscribe(u => this.onAuthChange(u));
        await this._handleOAuthReturn();
        await AuthState.checkAuth();
        return this;
    }

    // Capture a token handed back via URL (?token=… or #token=…) — the shape a
    // browser OAuth redirect should use once Bananauth's callback redirects
    // instead of returning JSON.
    async _handleOAuthReturn() {
        const q = new URLSearchParams(window.location.search);
        const h = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
        const token = q.get('token') || h.get('token');
        if (token) {
            history.replaceState({}, '', window.location.pathname);
            await AuthState.adopt(token, 'Account', q.get('provider') || 'oauth');
        }
    }

    _build() {
        let host = document.getElementById('bk-auth');
        if (!host) { host = document.createElement('div'); host.id = 'bk-auth'; document.body.appendChild(host); }

        const hasPassword = this.hasMethod('password');
        const hasDiscord = this.hasMethod('discord');

        host.innerHTML = `
          <div class="bk-overlay">
            <div class="bk-panel">
              <button class="bk-close" type="button" aria-label="Close">×</button>
              <h3 class="bk-title">Sign in</h3>
              <p class="bk-error" style="display:none"></p>
              ${hasPassword ? `
              <form class="bk-form">
                <input class="bk-email" type="email" placeholder="Email" autocomplete="email" required>
                <input class="bk-username" type="text" placeholder="Username" autocomplete="username" minlength="3" maxlength="32" style="display:none">
                <input class="bk-password" type="password" placeholder="Password" autocomplete="current-password" minlength="8" required>
                <button class="bk-submit" type="submit">Sign in</button>
              </form>
              <button class="bk-toggle" type="button">Need an account? Register</button>
              <button class="bk-forgot" type="button">Forgot password?</button>
              ` : ''}
              ${hasDiscord ? `<div class="bk-or">or</div><button class="bk-discord" type="button">Continue with Discord</button>` : ''}
              ${!hasPassword && !hasDiscord ? `<p>No login methods are enabled.</p>` : ''}
            </div>
          </div>`;

        this.el = host.querySelector('.bk-overlay');
        const $ = (s) => host.querySelector(s);

        $('.bk-close').onclick = () => this.hideAuth();
        this.el.onclick = (e) => { if (e.target === this.el) this.hideAuth(); };

        if (hasPassword) {
            const form = $('.bk-form');
            const errEl = $('.bk-error');
            const showErr = (m) => { errEl.textContent = m; errEl.style.display = m ? 'block' : 'none'; };

            $('.bk-toggle').onclick = () => {
                this.mode = this.mode === 'login' ? 'register' : 'login';
                const reg = this.mode === 'register';
                $('.bk-username').style.display = reg ? 'block' : 'none';
                $('.bk-title').textContent = reg ? 'Create account' : 'Sign in';
                $('.bk-submit').textContent = reg ? 'Register' : 'Sign in';
                $('.bk-toggle').textContent = reg ? 'Have an account? Sign in' : 'Need an account? Register';
                $('.bk-password').autocomplete = reg ? 'new-password' : 'current-password';
                showErr('');
            };

            form.onsubmit = async (e) => {
                e.preventDefault();
                showErr('');
                const email = $('.bk-email').value.trim();
                const password = $('.bk-password').value;
                const r = this.mode === 'register'
                    ? await AuthAPI.register(email, $('.bk-username').value.trim(), password)
                    : await AuthAPI.login(email, password);
                if (r.ok && r.data && r.data.access_token) {
                    await AuthState.adopt(r.data.access_token, email, 'password');
                    this.hideAuth();
                } else {
                    showErr((r.data && (r.data.message || r.data.error)) || 'Sign-in failed');
                }
            };

            $('.bk-forgot').onclick = async () => {
                const email = $('.bk-email').value.trim();
                if (!email) { showErr('Enter your email first'); return; }
                await AuthAPI.passwordForgot(email);
                showErr('If that email exists, a reset code has been sent.');
            };
        }

        if (hasDiscord) {
            $('.bk-discord').onclick = () => { window.location.href = '/auth/oauth/discord'; };
        }
    }

    showAuth() { this.el && this.el.classList.add('active'); }
    hideAuth() { this.el && this.el.classList.remove('active'); }
    isLoggedIn() { return AuthState.isLoggedIn(); }
    getUser() { return AuthState.user; }
    async logout() { await AuthState.logout(); }

    // 2FA is not a method this deployment exposes yet (no "totp" in config).
    // Surfaced explicitly rather than silently doing nothing.
    showTOTPSetup() { alert('Two-factor auth is not enabled for this deployment yet.'); }
}
