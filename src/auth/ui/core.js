/**
 * @bananalabs/auth - UI Core
 * Base component, API client, state manager
 */

// ============ BASE COMPONENT ============
export class AuthComponent {
    constructor(options = {}) {
        this.options = options;
        this.el = null;
        this._listeners = [];
    }

    render() { throw new Error('render() required'); }

    mount(container) {
        if (typeof container === 'string') container = document.querySelector(container);
        this.el = this.render();
        container.appendChild(this.el);
        this.wire();
        return this;
    }

    wire() {}

    on(target, event, handler) {
        const el = typeof target === 'string' ? this.el.querySelector(target) : target;
        if (el) {
            el.addEventListener(event, handler);
            this._listeners.push({ el, event, handler });
        }
    }

    show() { this.el?.classList.add('active'); }
    hide() { this.el?.classList.remove('active'); }

    destroy() {
        this._listeners.forEach(({ el, event, handler }) => el.removeEventListener(event, handler));
        this.el?.remove();
    }

    html(str) {
        const t = document.createElement('template');
        t.innerHTML = str.trim();
        return t.content.firstChild;
    }
}

// ============ API CLIENT ============
export const AuthAPI = {
    _post: (path, body) => fetch(`/auth${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(r => r.json()),

    _get: (path) => fetch(`/auth${path}`).then(r => r.json()),
    _del: (path) => fetch(`/auth${path}`, { method: 'DELETE' }).then(r => r.json()),

    // Session
    me: () => AuthAPI._get('/me'),
    logout: () => AuthAPI._post('/logout', {}),

    // Registration & Login
    register: (email, username) => AuthAPI._post('/register', { email, username, requireOtp: true }),
    login: (email, password) => AuthAPI._post('/login', { email, password }),

    // OTP
    otpRequest: (email) => AuthAPI._post('/otp/request', { email }),
    otpVerify: (code) => AuthAPI._post('/otp/verify', { code }),

    // Password Reset
    passwordForgot: (email) => AuthAPI._post('/password/forgot', { email }),
    passwordReset: (code, newPassword) => AuthAPI._post('/password/reset', { code, newPassword }),

    // TOTP
    totpSetup: () => AuthAPI._post('/totp/setup', {}),
    totpEnable: (code) => AuthAPI._post('/totp/enable', { code }),
    totpVerify: (userId, code) => AuthAPI._post('/totp/verify', { userId, code }),
    totpDisable: (code) => AuthAPI._post('/totp/disable', { code }),
    totpStatus: () => AuthAPI._get('/totp/status'),

    // Account
    deleteAccount: () => AuthAPI._del('/account'),
};

// ============ STATE ============
export const AuthState = {
    user: null,
    pendingUserId: null,
    _subs: [],

    subscribe(fn) {
        this._subs.push(fn);
        return () => { this._subs = this._subs.filter(s => s !== fn); };
    },

    _notify() { this._subs.forEach(fn => fn(this.user)); },

    async checkAuth() {
        this.user = await AuthAPI.me();
        this._notify();
        return this.user;
    },

    async logout() {
        await AuthAPI.logout();
        this.user = null;
        this._notify();
    },

    isLoggedIn() { return !!this.user; },

    handleLoginResponse(data) {
        if (data.requiresTotp) {
            this.pendingUserId = data.userId;
            return { requiresTOTP: true, userId: data.userId };
        }
        if (data.success) {
            this.checkAuth();
            return { success: true, usedRecoveryCode: data.usedRecoveryCode, remaining: data.remainingRecoveryCodes };
        }
        return { error: data.error };
    }
};