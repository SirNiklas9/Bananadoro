/**
 * @bananalabs/auth - UI Overlays
 * Self-contained modal components
 */

import { AuthComponent, AuthAPI, AuthState } from './core.js';

// ============ BASE OVERLAY ============
export class Overlay extends AuthComponent {
    constructor(opts = {}) {
        super(opts);
        this.title = opts.title || '';
        this.onClose = opts.onClose || (() => {});
    }

    render() {
        return this.html(`
            <div class="bk-overlay">
                <div class="bk-panel">
                    ${this.title ? `<h3 class="bk-title">${this.title}</h3>` : ''}
                    <div class="bk-content">${this.content()}</div>
                    <button class="bk-btn bk-btn-cancel bk-close">Cancel</button>
                </div>
            </div>
        `);
    }

    content() { return ''; }

    wire() {
        this.on(this.el, 'click', e => { if (e.target === this.el) { this.hide(); this.onClose(); } });
        this.on('.bk-close', 'click', () => { this.hide(); this.onClose(); });
    }
}

// ============ AUTH (Main Sign In) ============
export class AuthOverlay extends Overlay {
    constructor(opts = {}) {
        super({ ...opts, title: 'Sign In' });
        this.showOTP = opts.showOTP !== false;
        this.onOAuthMobile = opts.onOAuthMobile || (() => {});
        this.onOTPClick = opts.onOTPClick || (() => {});
    }

    content() {
        return `
            <p class="bk-sub">Sign in to sync your sessions across devices</p>
            <button class="bk-btn bk-btn-discord bk-discord">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
                Continue with Discord
            </button>
            ${this.showOTP ? `
                <div class="bk-divider"><hr><span>or</span><hr></div>
                <button class="bk-btn bk-btn-secondary bk-otp-trigger">Continue with Email</button>
            ` : ''}
        `;
    }

    wire() {
        super.wire();
        this.on('.bk-discord', 'click', () => {
            const mobile = typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform?.();
            if (mobile) {
                window.open('/auth/discord?mobile=true', '_system');
                this.hide();
                this.onOAuthMobile();
            } else {
                window.location.href = '/auth/discord';
            }
        });
        if (this.showOTP) this.on('.bk-otp-trigger', 'click', () => { this.hide(); this.onOTPClick(); });
    }
}

// ============ OTP ============
export class OTPOverlay extends Overlay {
    constructor(opts = {}) {
        super({ ...opts, title: 'Sign In with Email' });
        this.onSuccess = opts.onSuccess || (() => {});
        this.onRequiresTOTP = opts.onRequiresTOTP || (() => {});
        this.email = '';
    }

    content() {
        return `
            <div class="bk-step bk-request">
                <p class="bk-sub">We'll send you a code</p>
                <input type="email" class="bk-input bk-email" placeholder="Email">
                <button class="bk-btn bk-btn-primary bk-send">Send Code</button>
            </div>
            <div class="bk-step bk-verify" style="display:none">
                <p class="bk-sub">Check your email for the code</p>
                <input type="email" class="bk-input bk-email-show" disabled>
                <input type="text" class="bk-input bk-code" placeholder="Enter code" maxlength="6">
                <button class="bk-btn bk-btn-primary bk-verify-btn">Verify</button>
                <a href="#" class="bk-link bk-resend">Resend code</a>
            </div>
        `;
    }

    wire() {
        super.wire();
        this.on('.bk-send', 'click', () => this.send());
        this.on('.bk-email', 'keypress', e => e.key === 'Enter' && this.send());
        this.on('.bk-verify-btn', 'click', () => this.verify());
        this.on('.bk-code', 'keypress', e => e.key === 'Enter' && this.verify());
        this.on('.bk-resend', 'click', e => { e.preventDefault(); this.send(); });
    }

    async send() {
        const email = this.el.querySelector('.bk-email').value.trim();
        if (!email) return alert('Please enter your email');

        const btn = this.el.querySelector('.bk-send');
        btn.disabled = true; btn.textContent = 'Sending...';
        const data = await AuthAPI.otpRequest(email);
        btn.disabled = false; btn.textContent = 'Send Code';

        if (data.success) {
            this.email = email;
            this.el.querySelector('.bk-request').style.display = 'none';
            this.el.querySelector('.bk-verify').style.display = 'block';
            this.el.querySelector('.bk-email-show').value = email;
            this.el.querySelector('.bk-code').focus();
        } else {
            alert(data.error || 'Failed to send');
        }
    }

    async verify() {
        const code = this.el.querySelector('.bk-code').value.trim();
        if (!code) return alert('Please enter the code');

        const btn = this.el.querySelector('.bk-verify-btn');
        btn.disabled = true; btn.textContent = 'Verifying...';
        const data = await AuthAPI.otpVerify(code);
        const result = AuthState.handleLoginResponse(data);
        btn.disabled = false; btn.textContent = 'Verify';

        if (result.requiresTOTP) { this.hide(); this.onRequiresTOTP(result.userId); }
        else if (result.success) { this.hide(); this.reset(); this.onSuccess(result); }
        else alert(result.error || 'Invalid code');
    }

    reset() {
        this.email = '';
        this.el.querySelector('.bk-request').style.display = 'block';
        this.el.querySelector('.bk-verify').style.display = 'none';
        this.el.querySelector('.bk-email').value = '';
        this.el.querySelector('.bk-code').value = '';
    }
}

// ============ TOTP VERIFY (Login) ============
export class TOTPVerifyOverlay extends Overlay {
    constructor(opts = {}) {
        super({ ...opts, title: 'Two-Factor Authentication' });
        this.userId = '';
        this.onSuccess = opts.onSuccess || (() => {});
    }

    content() {
        return `
            <p class="bk-sub">Enter the code from your authenticator app</p>
            <input type="text" class="bk-input bk-code" placeholder="6-digit code or recovery code" maxlength="8">
            <p class="bk-hint">Recovery codes also work here</p>
            <button class="bk-btn bk-btn-primary bk-verify-btn">Verify</button>
        `;
    }

    wire() {
        super.wire();
        this.on('.bk-verify-btn', 'click', () => this.verify());
        this.on('.bk-code', 'keypress', e => e.key === 'Enter' && this.verify());
    }

    async verify() {
        const code = this.el.querySelector('.bk-code').value.trim();
        if (!code) return alert('Please enter a code');

        const btn = this.el.querySelector('.bk-verify-btn');
        btn.disabled = true; btn.textContent = 'Verifying...';
        const data = await AuthAPI.totpVerify(this.userId, code);
        btn.disabled = false; btn.textContent = 'Verify';

        if (data.success) {
            if (data.usedRecoveryCode) alert(`Recovery code used. ${data.remainingRecoveryCodes} remaining.`);
            this.hide(); this.reset(); this.onSuccess();
        } else alert(data.error || 'Invalid code');
    }

    setUserId(id) { this.userId = id; }
    reset() { this.el.querySelector('.bk-code').value = ''; }
    show() { super.show(); setTimeout(() => this.el.querySelector('.bk-code')?.focus(), 50); }
}

// ============ MOBILE CODE (OAuth) ============
export class MobileCodeOverlay extends Overlay {
    constructor(opts = {}) {
        super({ ...opts, title: 'Enter Your Code' });
        this.onSuccess = opts.onSuccess || (() => {});
        this.onRequiresTOTP = opts.onRequiresTOTP || (() => {});
    }

    content() {
        return `
            <p class="bk-sub">Enter the code shown in your browser</p>
            <input type="text" class="bk-input bk-code" placeholder="Enter code" maxlength="6">
            <button class="bk-btn bk-btn-primary bk-verify-btn">Verify</button>
        `;
    }

    wire() {
        super.wire();
        this.on('.bk-verify-btn', 'click', () => this.verify());
        this.on('.bk-code', 'keypress', e => e.key === 'Enter' && this.verify());
    }

    async verify() {
        const code = this.el.querySelector('.bk-code').value.trim();
        if (!code) return alert('Please enter code');

        const btn = this.el.querySelector('.bk-verify-btn');
        btn.disabled = true; btn.textContent = 'Verifying...';
        const data = await AuthAPI.otpVerify(code);
        const result = AuthState.handleLoginResponse(data);
        btn.disabled = false; btn.textContent = 'Verify';

        if (result.requiresTOTP) { this.hide(); this.reset(); this.onRequiresTOTP(result.userId); }
        else if (result.success) { this.hide(); this.reset(); this.onSuccess(result); }
        else alert(result.error || 'Invalid code');
    }

    reset() { this.el.querySelector('.bk-code').value = ''; }
}

// ============ TOTP SETUP ============
export class TOTPSetupOverlay extends Overlay {
    constructor(opts = {}) {
        super({ ...opts, title: 'Setup Two-Factor Auth' });
        this.onEnabled = opts.onEnabled || (() => {});
    }

    content() {
        return `
            <div class="bk-qr-section">
                <p class="bk-sub">Scan with your authenticator app</p>
                <div class="bk-qr">Loading...</div>
                <p class="bk-hint">Or enter manually:</p>
                <code class="bk-secret">Loading...</code>
            </div>
            <input type="text" class="bk-input bk-code" placeholder="Enter 6-digit code" maxlength="6">
            <button class="bk-btn bk-btn-primary bk-enable">Enable 2FA</button>
        `;
    }

    wire() {
        super.wire();
        this.on('.bk-enable', 'click', () => this.enable());
        this.on('.bk-code', 'keypress', e => e.key === 'Enter' && this.enable());
    }

    async load() {
        const data = await AuthAPI.totpSetup();
        if (data.secret && data.qrUrl) {
            this.el.querySelector('.bk-secret').textContent = data.secret;
            this.el.querySelector('.bk-qr').innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(data.qrUrl)}" alt="QR">`;
        } else { alert(data.error || 'Setup failed'); this.hide(); }
    }

    async enable() {
        const code = this.el.querySelector('.bk-code').value.trim();
        if (!code || code.length !== 6) return alert('Enter 6-digit code');

        const btn = this.el.querySelector('.bk-enable');
        btn.disabled = true; btn.textContent = 'Enabling...';
        const data = await AuthAPI.totpEnable(code);
        btn.disabled = false; btn.textContent = 'Enable 2FA';

        if (data.success) { this.hide(); this.reset(); this.onEnabled(data.recoveryCodes); }
        else alert(data.error || 'Invalid code');
    }

    reset() { this.el.querySelector('.bk-code').value = ''; }
    show() { super.show(); this.load(); }
}

// ============ RECOVERY CODES ============
export class RecoveryCodesOverlay extends Overlay {
    constructor(opts = {}) {
        super({ ...opts, title: '⚠️ Save Your Recovery Codes' });
        this.codes = [];
    }

    content() {
        return `
            <p class="bk-sub">Save these somewhere safe. You won't see them again.</p>
            <div class="bk-codes"></div>
            <button class="bk-btn bk-btn-secondary bk-copy">Copy Codes</button>
            <button class="bk-btn bk-btn-primary bk-done">I've Saved Them</button>
        `;
    }

    wire() {
        super.wire();
        this.on('.bk-copy', 'click', () => {
            navigator.clipboard.writeText(this.codes.join('\n'));
            this.el.querySelector('.bk-copy').textContent = 'Copied!';
        });
        this.on('.bk-done', 'click', () => { this.hide(); this.onClose(); });
    }

    setCodes(codes) {
        this.codes = codes;
        if (this.el) {
            this.el.querySelector('.bk-codes').innerHTML = codes.map(c => `<code class="bk-rc">${c}</code>`).join('');
        }
    }
}

// ============ PASSWORD RESET ============
export class PasswordResetOverlay extends Overlay {
    constructor(opts = {}) {
        super({ ...opts, title: 'Reset Password' });
        this.onSuccess = opts.onSuccess || (() => {});
    }

    content() {
        return `
            <div class="bk-step bk-request">
                <p class="bk-sub">Enter your email to receive a reset code</p>
                <input type="email" class="bk-input bk-email" placeholder="Email">
                <button class="bk-btn bk-btn-primary bk-send">Send Code</button>
            </div>
            <div class="bk-step bk-verify" style="display:none">
                <p class="bk-sub">Enter the code and your new password</p>
                <input type="text" class="bk-input bk-code" placeholder="Enter code" maxlength="6">
                <input type="password" class="bk-input bk-pw" placeholder="New password (min 8 chars)">
                <input type="password" class="bk-input bk-pw2" placeholder="Confirm password">
                <button class="bk-btn bk-btn-primary bk-submit">Reset Password</button>
            </div>
        `;
    }

    wire() {
        super.wire();
        this.on('.bk-send', 'click', () => this.send());
        this.on('.bk-email', 'keypress', e => e.key === 'Enter' && this.send());
        this.on('.bk-submit', 'click', () => this.submit());
        this.on('.bk-pw2', 'keypress', e => e.key === 'Enter' && this.submit());
    }

    async send() {
        const email = this.el.querySelector('.bk-email').value.trim();
        if (!email) return alert('Enter your email');

        const btn = this.el.querySelector('.bk-send');
        btn.disabled = true; btn.textContent = 'Sending...';
        const data = await AuthAPI.passwordForgot(email);
        btn.disabled = false; btn.textContent = 'Send Code';

        if (data.success) {
            this.el.querySelector('.bk-request').style.display = 'none';
            this.el.querySelector('.bk-verify').style.display = 'block';
        } else alert(data.error || 'Failed');
    }

    async submit() {
        const code = this.el.querySelector('.bk-code').value.trim();
        const pw = this.el.querySelector('.bk-pw').value;
        const pw2 = this.el.querySelector('.bk-pw2').value;

        if (!code) return alert('Enter the code');
        if (!pw || pw.length < 8) return alert('Password must be 8+ chars');
        if (pw !== pw2) return alert('Passwords do not match');

        const btn = this.el.querySelector('.bk-submit');
        btn.disabled = true; btn.textContent = 'Resetting...';
        const data = await AuthAPI.passwordReset(code, pw);
        btn.disabled = false; btn.textContent = 'Reset Password';

        if (data.success) { alert('Password reset!'); this.hide(); this.reset(); this.onSuccess(); }
        else alert(data.error || 'Invalid code');
    }

    reset() {
        this.el.querySelector('.bk-request').style.display = 'block';
        this.el.querySelector('.bk-verify').style.display = 'none';
        this.el.querySelectorAll('.bk-input').forEach(i => i.value = '');
    }
}

// ============ REGISTER ============
export class RegisterOverlay extends Overlay {
    constructor(opts = {}) {
        super({ ...opts, title: 'Create Account' });
        this.onCodeSent = opts.onCodeSent || (() => {});
        this.onLoginClick = opts.onLoginClick || (() => {});
    }

    content() {
        return `
            <p class="bk-sub">We'll send you a verification code</p>
            <input type="text" class="bk-input bk-user" placeholder="Username">
            <input type="email" class="bk-input bk-email" placeholder="Email">
            <button class="bk-btn bk-btn-primary bk-register">Create Account</button>
            <a href="#" class="bk-link bk-login">Already have an account? Sign In</a>
        `;
    }

    wire() {
        super.wire();
        this.on('.bk-register', 'click', () => this.register());
        this.on('.bk-email', 'keypress', e => e.key === 'Enter' && this.register());
        this.on('.bk-login', 'click', e => { e.preventDefault(); this.hide(); this.onLoginClick(); });
    }

    async register() {
        const username = this.el.querySelector('.bk-user').value.trim();
        const email = this.el.querySelector('.bk-email').value.trim();
        if (!username || !email) return alert('Enter username and email');

        const btn = this.el.querySelector('.bk-register');
        btn.disabled = true; btn.textContent = 'Creating...';
        const data = await AuthAPI.register(email, username);
        btn.disabled = false; btn.textContent = 'Create Account';

        if (data.success) { this.hide(); this.reset(); this.onCodeSent(email); }
        else alert(data.error || 'Failed');
    }

    reset() {
        this.el.querySelector('.bk-user').value = '';
        this.el.querySelector('.bk-email').value = '';
    }
}