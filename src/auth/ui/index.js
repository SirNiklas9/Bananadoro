/**
 * @bananalabs/auth - UI
 *
 * Usage:
 *   import { AuthUI } from '/auth/ui/index.js';
 *   const auth = new AuthUI({ onAuthChange: updateUI }).init();
 *   auth.showAuth();
 */

export { AuthComponent, AuthAPI, AuthState } from './core.js';
export * from './overlays.js';

import { AuthState } from './core.js';
import {
    AuthOverlay, OTPOverlay, TOTPVerifyOverlay, MobileCodeOverlay,
    TOTPSetupOverlay, RecoveryCodesOverlay, PasswordResetOverlay, RegisterOverlay
} from './overlays.js';

export class AuthUI {
    constructor(opts = {}) {
        this.onAuthChange = opts.onAuthChange || (() => {});
        this.enableOTP = opts.enableOTP !== false;
        this.enableTOTP = opts.enableTOTP !== false;
        this.enableRegister = opts.enableRegister !== false;

        // Overlays
        this.auth = null;
        this.otp = null;
        this.totpVerify = null;
        this.mobileCode = null;
        this.totpSetup = null;
        this.recoveryCodes = null;
        this.passwordReset = null;
        this.register = null;
    }

    init() {
        let c = document.getElementById('bk-auth');
        if (!c) { c = document.createElement('div'); c.id = 'bk-auth'; document.body.appendChild(c); }

        // Main auth
        this.auth = new AuthOverlay({
            showOTP: this.enableOTP,
            onOTPClick: () => this.showOTP(),
            onOAuthMobile: () => this.showMobileCode(),
        });
        this.auth.mount(c);

        // OTP
        if (this.enableOTP) {
            this.otp = new OTPOverlay({
                onSuccess: () => this._done(),
                onRequiresTOTP: (id) => this.showTOTPVerify(id),
            });
            this.otp.mount(c);
        }

        // TOTP
        if (this.enableTOTP) {
            this.totpVerify = new TOTPVerifyOverlay({ onSuccess: () => this._done() });
            this.totpVerify.mount(c);

            this.totpSetup = new TOTPSetupOverlay({ onEnabled: (codes) => this.showRecoveryCodes(codes) });
            this.totpSetup.mount(c);

            this.recoveryCodes = new RecoveryCodesOverlay({
                onClose: () => window.updateTotpBtn()
            });
            this.recoveryCodes.mount(c);
        }

        // Mobile code
        this.mobileCode = new MobileCodeOverlay({
            onSuccess: () => this._done(),
            onRequiresTOTP: (id) => this.showTOTPVerify(id),
        });
        this.mobileCode.mount(c);

        // Password reset
        this.passwordReset = new PasswordResetOverlay({ onSuccess: () => this.showAuth() });
        this.passwordReset.mount(c);

        // Register
        if (this.enableRegister) {
            this.register = new RegisterOverlay({
                onCodeSent: (email) => {
                    if (this.otp) {
                        this.otp.email = email;
                        this.otp.el.querySelector('.bk-request').style.display = 'none';
                        this.otp.el.querySelector('.bk-verify').style.display = 'block';
                        this.otp.el.querySelector('.bk-email-show').value = email;
                        this.otp.show();
                    }
                },
                onLoginClick: () => this.showAuth(),
            });
            this.register.mount(c);
        }

        // State
        AuthState.subscribe(user => this.onAuthChange(user));
        this._checkParams();
        AuthState.checkAuth();

        return this;
    }

    _checkParams() {
        const p = new URLSearchParams(window.location.search);
        if (p.get('auth') === 'success') {
            history.replaceState({}, '', location.pathname);
            this._done();
        } else if (p.get('auth') === 'totp' && p.get('userId')) {
            history.replaceState({}, '', location.pathname);
            this.showTOTPVerify(p.get('userId'));
        }
    }

    _done() { AuthState.checkAuth(); }

    // Public API
    showAuth() { this.auth?.show(); }
    hideAuth() { this.auth?.hide(); }
    showOTP() { this.otp?.show(); }
    hideOTP() { this.otp?.hide(); }
    showTOTPVerify(userId) { if (this.totpVerify) { this.totpVerify.setUserId(userId); this.totpVerify.show(); } }
    hideTOTPVerify() { this.totpVerify?.hide(); }
    showMobileCode() { this.mobileCode?.show(); }
    hideMobileCode() { this.mobileCode?.hide(); }
    showTOTPSetup() { this.totpSetup?.show(); }
    hideTOTPSetup() { this.totpSetup?.hide(); }
    showRecoveryCodes(codes) { if (this.recoveryCodes) { this.recoveryCodes.setCodes(codes); this.recoveryCodes.show(); } }
    showPasswordReset() { this.passwordReset?.show(); }
    hidePasswordReset() { this.passwordReset?.hide(); }
    showRegister() { this.register?.show(); }
    hideRegister() { this.register?.hide(); }

    // State shortcuts
    isLoggedIn() { return AuthState.isLoggedIn(); }
    getUser() { return AuthState.user; }
    async logout() { await AuthState.logout(); }
}