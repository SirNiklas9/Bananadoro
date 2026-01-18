import {Context, Hono} from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import {lucia} from "./lucia";
import { generateId } from 'lucia'
import { db } from '../db'
import {users, nativeAccounts, oauthAccounts, sessions, otpCodes, totpSecrets, recoveryCode} from "./schema";
import {and, eq, gt} from "drizzle-orm";
import { discord } from "./oauth";
import { generateSecret, verify, generateURI } from 'otplib';
import { sendOTPEmail } from '../lib/email';

// ============ Helper METHODS ============
// Generate a 6-character OTP code
function generateOTP(): string {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Generate recovery codes (10 codes, 8 chars each)
function generateRecoveryCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < 10; i++) {
        codes.push(Math.random().toString(36).substring(2, 10).toUpperCase());
    }
    return codes;
}

// Checks TOTP before creating session
async function finishLogin(
    c: Context,
    userId: string,
    options?: { redirect?: string; isMobile?: boolean }
): Promise<Response> {
    // Check if user has TOTP enabled
    const [totp] = await db
        .select()
        .from(totpSecrets)
        .where(and(
            eq(totpSecrets.userId, userId),
            eq(totpSecrets.verified, true)
        ));

    if (totp) {
        // TOTP required - don't create session yet
        if (options?.redirect) {
            return c.redirect(`${options.redirect}${options.redirect.includes('?') ? '&' : '?'}auth=totp&userId=${userId}`);
        }
        return c.json({ success: false, requiresTotp: true, userId });
    }

    // No TOTP - create session normally
    const session = await lucia.createSession(userId, {});
    const cookie = lucia.createSessionCookie(session.id);
    setCookie(c, cookie.name, cookie.value, cookie.attributes);

    if (options?.redirect) {
        return c.redirect(`${options.redirect}${options.redirect.includes('?') ? '&' : '?'}auth=success`);
    }
    return c.json({ success: true });
}

const auth = new Hono()

// ============ Native ROUTES ============
auth.get('/me', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName)

    if (!sessionId) {
        return c.json(null)
    }

    const { session, user } = await lucia.validateSession(sessionId)

    if (!session) {
        return c.json(null)
    }

    // Get OAuth account for username
    const [oauth] = await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, user.id))

    if (oauth) {
        return c.json({
            id: user.id,
            email: user.email,
            username: oauth?.providerUsername ?? null,
            provider: oauth?.provider ?? null
        })
    }

    // Get native account for username
    const [native] = await db
        .select()
        .from(nativeAccounts)
        .where(eq(nativeAccounts.userId, user.id))

    return c.json({
        id: user.id,
        username: native?.username ?? native?.email,
        provider: 'native'
    })
})

auth.post('/register', async (c) => {
    const { email, password, username, requireOtp = true } = await c.req.json()

    if (!email || !username) {
        return c.json({ error: 'Email and username required' }, 400)
    }

    // Check if email already exists
    const [existingUser] = await db.select().from(users).where(eq(users.email, email))
    if (existingUser) {
        return c.json({ error: 'Email already registered' }, 400)
    }

    // Check if username already taken
    const [existingUsername] = await db.select().from(nativeAccounts).where(eq(nativeAccounts.username, username))
    if (existingUsername) {
        return c.json({ error: 'Username already taken' }, 400)
    }

    const now = new Date()

    // If OTP required, send code and wait for verification
    if (requireOtp) {
        await db.delete(otpCodes).where(eq(otpCodes.email, email))

        const code = generateOTP()
        const expiresAt = new Date(now.getTime() + 10 * 60 * 1000)

        const metadata: { username: string; passwordHash?: string } = { username }
        if (password) {
            metadata.passwordHash = await Bun.password.hash(password)
        }

        await db.insert(otpCodes).values({
            id: generateId(15),
            email: email,
            code: code,
            type: 'register',
            expiresAt: expiresAt,
            createdAt: now,
            metadata: JSON.stringify(metadata)
        })

        try {
            await sendOTPEmail(email, code)
        } catch (err) {
            console.error('Email failed:', err);
            console.log(`OTP for ${email}: ${code}`);
        }

        return c.json({ success: true, requiresVerification: true })
    }

    // No OTP - create account immediately
    const userId = generateId(15)

    await db.insert(users).values({
        id: userId,
        email: email,
        createdAt: now,
        updatedAt: now,
    })

    await db.insert(nativeAccounts).values({
        id: generateId(15),
        userId: userId,
        email: email,
        username: username,
        passwordHash: password ? await Bun.password.hash(password) : '',
        createdAt: now,
    })

    // Create session
    const session = await lucia.createSession(userId, {})
    const cookie = lucia.createSessionCookie(session.id)
    setCookie(c, cookie.name, cookie.value, cookie.attributes)

    return c.json({ success: true, requiresVerification: false })
})

auth.post('/login', async (c) => {
    const { email, password } = await c.req.json()

    // Find the account
    const [account] = await db.select().from(nativeAccounts).where(eq(nativeAccounts.email, email))

    if (!account) {
        return c.json({ error: 'Invalid credentials' }, 401)
    }

    // Verify password
    const valid = await Bun.password.verify(password, account.passwordHash)

    if (!valid) {
        return c.json({ error: 'Invalid credentials' }, 401)
    }

    // Use finishLogin to check TOTP
    return finishLogin(c, account.userId)
})

auth.post('/logout', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName)

    if (sessionId) {
        await lucia.invalidateSession(sessionId)
    }

    const cookie = lucia.createBlankSessionCookie()
    setCookie(c, cookie.name, cookie.value, cookie.attributes)

    return c.json({ success: true })
})

auth.post('/set-password', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName);
    if (!sessionId) return c.json({ error: 'Not logged in' }, 401);

    const { session, user } = await lucia.validateSession(sessionId);
    if (!session) return c.json({ error: 'Not logged in' }, 401);

    const { password } = await c.req.json();

    if (!password || password.length < 8) {
        return c.json({ error: 'Password must be at least 8 characters' }, 400);
    }

    // Check if they already have a native account
    const [existing] = await db
        .select()
        .from(nativeAccounts)
        .where(eq(nativeAccounts.userId, user.id));

    if (existing) {
        return c.json({ error: 'Password already set' }, 400);
    }

    // Get their email from users table
    const [userData] = await db
        .select()
        .from(users)
        .where(eq(users.id, user.id));

    if (!userData?.email) {
        return c.json({ error: 'No email on account' }, 400);
    }

    const hashedPassword = await Bun.password.hash(password);

    await db.insert(nativeAccounts).values({
        id: generateId(15),
        userId: user.id,
        email: userData.email,
        passwordHash: hashedPassword,
        createdAt: new Date(),
    });

    return c.json({ success: true });
});

// ============ PASSWORD RESET ============
auth.post('/password/forgot', async (c) => {
    const { email } = await c.req.json();

    if (!email) {
        return c.json({ error: 'Email required' }, 400);
    }

    // Check if user exists with a native account
    const [account] = await db
        .select()
        .from(nativeAccounts)
        .where(eq(nativeAccounts.email, email));

    // Always return success to prevent email enumeration
    if (!account) {
        return c.json({ success: true });
    }

    // Delete existing reset codes
    await db.delete(otpCodes).where(
        and(
            eq(otpCodes.email, email),
            eq(otpCodes.type, 'password_reset')
        )
    );

    const code = generateOTP();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);

    await db.insert(otpCodes).values({
        id: generateId(15),
        email: email,
        code: code,
        type: 'password_reset',
        expiresAt: expiresAt,
        createdAt: now,
        metadata: JSON.stringify({ userId: account.userId })
    });

    try {
        await sendOTPEmail(email, code);
    } catch (err) {
        console.error('Email failed:', err);
        console.log(`Password reset OTP for ${email}: ${code}`);
    }

    return c.json({ success: true });
});

auth.post('/password/reset', async (c) => {
    const { code, newPassword } = await c.req.json();

    if (!code || !newPassword) {
        return c.json({ error: 'Code and new password required' }, 400);
    }

    if (newPassword.length < 8) {
        return c.json({ error: 'Password must be at least 8 characters' }, 400);
    }

    // Find valid OTP
    const [otp] = await db
        .select()
        .from(otpCodes)
        .where(
            and(
                eq(otpCodes.code, code.toUpperCase()),
                eq(otpCodes.type, 'password_reset'),
                gt(otpCodes.expiresAt, new Date())
            )
        );

    if (!otp || !otp.metadata) {
        return c.json({ error: 'Invalid or expired code' }, 401);
    }

    const { userId } = JSON.parse(otp.metadata);

    // Delete used OTP
    await db.delete(otpCodes).where(eq(otpCodes.id, otp.id));

    // Update password
    const hashedPassword = await Bun.password.hash(newPassword);
    await db
        .update(nativeAccounts)
        .set({ passwordHash: hashedPassword })
        .where(eq(nativeAccounts.userId, userId));

    // Invalidate all sessions for this user (security)
    await db.delete(sessions).where(eq(sessions.userId, userId));

    return c.json({ success: true });
});


// ============ OAuth ROUTES ============
auth.get('/discord', async (c) => {
    const isMobile = c.req.query('mobile') === 'true'
    const state = isMobile ? `${generateId(15)}_mobile` : generateId(15)

    const url = discord.createAuthorizationURL(state, null, ['identify', 'email'])

    setCookie(c, 'oauth_state', state, {
        httpOnly: true,
        maxAge: 60 * 10,
        path: '/',
    })

    return c.redirect(url.toString())
})

auth.get('/discord/callback', async (c) => {
    const code = c.req.query('code')
    const state = c.req.query('state') || ''
    const storedState = getCookie(c, 'oauth_state')
    const isMobile = state.endsWith('_mobile')

    // Skip state validation for mobile (different browser context)
    if (!isMobile && state !== storedState) {
        return c.json({ error: 'Invalid state' }, 400)
    }

    if (!code) {
        return c.json({ error: 'No code provided' }, 400)
    }

    // Exchange code for tokens
    const tokens = await discord.validateAuthorizationCode(code, null)

    // Get Discord user info
    const discordUser = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokens.accessToken()}` }
    }).then(r => r.json())

    // Check if this Discord account is already linked
    const [existingOAuth] = await db
        .select()
        .from(oauthAccounts)
        .where(eq(oauthAccounts.providerUserId, discordUser.id))

    // For mobile: generate code and show it, don't create session
    if (isMobile) {
        const otpCode = generateOTP()
        const now = new Date()
        const expiresAt = new Date(now.getTime() + 10 * 60 * 1000)

        await db.insert(otpCodes).values({
            id: generateId(15),
            email: discordUser.email,
            code: otpCode,
            type: 'oauth_mobile',
            expiresAt: expiresAt,
            createdAt: now,
            metadata: JSON.stringify({
                provider: 'discord',
                providerUserId: discordUser.id,
                providerUsername: discordUser.username,
                existingUserId: existingOAuth?.userId || null
            })
        })

        // Show page with code (user types this into app)
        return c.html(`
            <html>
            <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a1a; color: white;">
                <div style="text-align: center;">
                    <h2>Your login code</h2>
                    <p style="font-size: 48px; font-weight: bold; letter-spacing: 8px; color: #f4d03f;">${otpCode}</p>
                    <p>Enter this code in the app</p>
                </div>
            </body>
            </html>
        `)
    }

    // Desktop: normal flow
    let userId: string

    if (existingOAuth) {
        // Existing user, just log them in
        userId = existingOAuth.userId
    } else {
        // New user, create account
        userId = generateId(15)
        const now = new Date()

        await db.insert(users).values({
            id: userId,
            email: discordUser.email,
            createdAt: now,
            updatedAt: now,
        })

        await db.insert(oauthAccounts).values({
            id: generateId(15),
            userId: userId,
            provider: 'discord',
            providerUserId: discordUser.id,
            providerUsername: discordUser.username,
            createdAt: now,
        })
    }

    // Use finishLogin to check TOTP (redirects if needed)
    return finishLogin(c, userId, { redirect: '/' });
})

auth.delete('/account', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName)
    if (!sessionId) return c.json({ error: 'Not logged in' }, 401)

    const { session, user } = await lucia.validateSession(sessionId)
    if (!session) return c.json({ error: 'Not logged in' }, 401)

    // Delete auth data
    await db.delete(totpSecrets).where(eq(totpSecrets.userId, user.id))
    await db.delete(recoveryCode).where(eq(recoveryCode.userId, user.id))
    await db.delete(oauthAccounts).where(eq(oauthAccounts.userId, user.id))
    await db.delete(nativeAccounts).where(eq(nativeAccounts.userId, user.id))
    await db.delete(sessions).where(eq(sessions.userId, user.id))
    await db.delete(users).where(eq(users.id, user.id))

    // Clear cookie
    const cookie = lucia.createBlankSessionCookie()
    setCookie(c, cookie.name, cookie.value, cookie.attributes)

    return c.json({ success: true })
})

// ============ OTP ROUTES ============
// Request OTP - sends code to email
auth.post('/otp/request', async (c) => {
    const { email } = await c.req.json();

    if (!email) {
        return c.json({ error: 'Email required' }, 400);
    }

    // Delete any existing OTPs for this email
    await db.delete(otpCodes).where(eq(otpCodes.email, email));

    // Generate new OTP
    const code = generateOTP();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

    await db.insert(otpCodes).values({
        id: generateId(15),
        email: email,
        code: code,
        type: 'login',
        expiresAt: expiresAt,
        createdAt: now,
    });

    // Try to send email, but don't crash if it fails
    try {
        // In production, send email:
        await sendOTPEmail(email, code);
    } catch (err) {
        console.error('Email failed:', err);
        console.log(`OTP for ${email}: ${code}`);
    }

    return c.json({ success: true });
});

// Verify OTP - logs user in
auth.post('/otp/verify', async (c) => {
    const { code } = await c.req.json();

    if (!code) {
        return c.json({ error: 'Code required' }, 400);
    }

    // Find valid OTP
    const [otp] = await db
        .select()
        .from(otpCodes)
        .where(
            and(
                eq(otpCodes.code, code.toUpperCase()),
                gt(otpCodes.expiresAt, new Date())
            )
        );

    if (!otp) {
        return c.json({ error: 'Invalid or expired code' }, 401);
    }

    // Delete used OTP
    await db.delete(otpCodes).where(eq(otpCodes.id, otp.id));

    const now = new Date();
    const email = otp.email;

    // Handle OAuth mobile flow
    switch (otp.type) {
        case 'oauth_mobile': {
            if (!otp.metadata) return c.json({ error: 'Invalid OTP data' }, 400);

            const { provider, providerUserId, providerUsername, existingUserId } = JSON.parse(otp.metadata);
            let userId: string;

            if (existingUserId) {
                userId = existingUserId;
            } else {
                userId = generateId(15);

                await db.insert(users).values({
                    id: userId,
                    email: email,
                    createdAt: now,
                    updatedAt: now,
                });

                await db.insert(oauthAccounts).values({
                    id: generateId(15),
                    userId: userId,
                    provider: provider,
                    providerUserId: providerUserId,
                    providerUsername: providerUsername,
                    createdAt: now,
                });
            }

            // Use finishLogin to check TOTP
            return finishLogin(c, userId);
        }

        case 'register': {
            if (!otp.metadata) return c.json({ error: 'Invalid OTP data' }, 400);

            const { username, passwordHash } = JSON.parse(otp.metadata);
            const userId = generateId(15);

            await db.insert(users).values({
                id: userId,
                email: email,
                createdAt: now,
                updatedAt: now,
            });

            await db.insert(nativeAccounts).values({
                id: generateId(15),
                userId: userId,
                email: email,
                username: username,
                passwordHash: passwordHash || '',
                createdAt: now,
            });

            const session = await lucia.createSession(userId, {});
            const cookie = lucia.createSessionCookie(session.id);
            setCookie(c, cookie.name, cookie.value, cookie.attributes);

            return c.json({ success: true });
        }

        case 'login':
        default: {
            let [user] = await db.select().from(users).where(eq(users.email, email));

            if (!user) {
                const userId = generateId(15);

                await db.insert(users).values({
                    id: userId,
                    email: email,
                    createdAt: now,
                    updatedAt: now,
                });

                // Create native account with email as username
                await db.insert(nativeAccounts).values({
                    id: generateId(15),
                    userId: userId,
                    email: email,
                    username: email.split('@')[0],
                    passwordHash: '',
                    createdAt: now,
                });

                [user] = await db.select().from(users).where(eq(users.id, userId));
            }

            // Use finishLogin to check TOTP
            return finishLogin(c, user.id);
        }
    }
});

// ============ TOTP ROUTES ============
// Setup TOTP - generates secret and QR code URL
auth.post('/totp/setup', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName);
    if (!sessionId) return c.json({ error: 'Not logged in' }, 401);

    const { session, user } = await lucia.validateSession(sessionId);
    if (!session) return c.json({ error: 'Not logged in' }, 401);

    // Check if already has TOTP
    const [existing] = await db
        .select()
        .from(totpSecrets)
        .where(eq(totpSecrets.userId, user.id));

    if (existing?.verified) {
        return c.json({ error: 'TOTP already enabled' }, 400);
    }

    // Delete any unverified secrets
    await db.delete(totpSecrets).where(eq(totpSecrets.userId, user.id));

    // Generate new secret
    const secret = generateSecret();

    await db.insert(totpSecrets).values({
        id: generateId(15),
        userId: user.id,
        secret: secret,
        verified: false,
        createdAt: new Date(),
    });

    // Generate QR code URL
    const qrUrl = generateURI({
        issuer: 'BananaLabs',
        label: user.email ?? user.id,
        secret: secret,
    });

    return c.json({
        secret: secret,
        qrUrl: qrUrl,
    });
});

// Verify and enable TOTP
auth.post('/totp/enable', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName);
    if (!sessionId) return c.json({ error: 'Not logged in' }, 401);

    const { session, user } = await lucia.validateSession(sessionId);
    if (!session) return c.json({ error: 'Not logged in' }, 401);

    const { code } = await c.req.json();

    if (!code) {
        return c.json({ error: 'Code required' }, 400);
    }

    // Get unverified secret
    const [totpRecord] = await db
        .select()
        .from(totpSecrets)
        .where(
            and(
                eq(totpSecrets.userId, user.id),
                eq(totpSecrets.verified, false)
            )
        );

    if (!totpRecord) {
        return c.json({ error: 'No TOTP setup in progress' }, 400);
    }

    // Verify code
    const isValid = await verify({ secret: totpRecord.secret, token: code });

    if (!isValid) {
        return c.json({ error: 'Invalid code' }, 401);
    }

    // Mark as verified
    await db
        .update(totpSecrets)
        .set({ verified: true })
        .where(eq(totpSecrets.id, totpRecord.id));

    // Generate recovery codes
    const codes = generateRecoveryCodes();
    const now = new Date();

    // Store hashed recovery codes
    for (const recoveryCodeValue of codes) {
        const hashed = await Bun.password.hash(recoveryCodeValue);
        await db.insert(recoveryCode).values({
            id: generateId(15),
            userId: user.id,
            codeHash: hashed,
            used: false,
            createdAt: now,
        });
    }

    return c.json({
        success: true,
        recoveryCodes: codes, // Show these ONCE to user
    });
});

// Verify TOTP during login
auth.post('/totp/verify', async (c) => {
    const { userId, code } = await c.req.json();

    if (!userId || !code) {
        return c.json({ error: 'User ID and code required' }, 400);
    }

    // Get verified secret
    const [totpRecord] = await db
        .select()
        .from(totpSecrets)
        .where(
            and(
                eq(totpSecrets.userId, userId),
                eq(totpSecrets.verified, true)
            )
        );

    if (!totpRecord) {
        return c.json({ error: 'TOTP not enabled' }, 400);
    }

    // Try TOTP code first
    const isValid = await verify({secret: totpRecord.secret, token: code});

    if (isValid) {
        // Create session
        const session = await lucia.createSession(userId, {});
        const cookie = lucia.createSessionCookie(session.id);
        setCookie(c, cookie.name, cookie.value, cookie.attributes);

        return c.json({ success: true });
    }

    // Try recovery code
    const recoveryCodes = await db
        .select()
        .from(recoveryCode)
        .where(
            and(
                eq(recoveryCode.userId, userId),
                eq(recoveryCode.used, false)
            )
        );

    for (const rc of recoveryCodes) {
        const matches = await Bun.password.verify(code.toUpperCase(), rc.codeHash);
        if (matches) {
            // Mark recovery code as used
            await db
                .update(recoveryCode)
                .set({ used: true })
                .where(eq(recoveryCode.id, rc.id));

            // Create session
            const session = await lucia.createSession(userId, {});
            const cookie = lucia.createSessionCookie(session.id);
            setCookie(c, cookie.name, cookie.value, cookie.attributes);

            // Count remaining codes
            const remaining = recoveryCodes.length - 1;

            return c.json({
                success: true,
                usedRecoveryCode: true,
                remainingRecoveryCodes: remaining
            });
        }
    }

    return c.json({ error: 'Invalid code' }, 401);
});

// Disable TOTP
auth.post('/totp/disable', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName);
    if (!sessionId) return c.json({ error: 'Not logged in' }, 401);

    const { session, user } = await lucia.validateSession(sessionId);
    if (!session) return c.json({ error: 'Not logged in' }, 401);

    const { code } = await c.req.json();

    // Verify current TOTP before disabling
    const [totpRecord] = await db
        .select()
        .from(totpSecrets)
        .where(eq(totpSecrets.userId, user.id));

    if (!totpRecord) {
        return c.json({ error: 'TOTP not enabled' }, 400);
    }

    const isValid = await verify({ secret: totpRecord.secret, token: code });

    if (!isValid) {
        return c.json({ error: 'Invalid code' }, 401);
    }

    await db.delete(totpSecrets).where(eq(totpSecrets.userId, user.id));

    return c.json({ success: true });
});

// Check if user has TOTP enabled
auth.get('/totp/status', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName);
    if (!sessionId) return c.json({ enabled: false });

    const { session, user } = await lucia.validateSession(sessionId);
    if (!session) return c.json({ enabled: false });

    const [totpRecord] = await db
        .select()
        .from(totpSecrets)
        .where(
            and(
                eq(totpSecrets.userId, user.id),
                eq(totpSecrets.verified, true)
            )
        );

    // Count remaining recovery codes
    const codes = await db
        .select()
        .from(recoveryCode)
        .where(
            and(
                eq(recoveryCode.userId, user.id),
                eq(recoveryCode.used, false)
            )
        );

    return c.json({
        enabled: !!totpRecord,
        remainingRecoveryCodes: codes.length
    });
});

// Regenerate recovery codes
auth.post('/totp/recovery/regenerate', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName);
    if (!sessionId) return c.json({ error: 'Not logged in' }, 401);

    const { session, user } = await lucia.validateSession(sessionId);
    if (!session) return c.json({ error: 'Not logged in' }, 401);

    const { code } = await c.req.json();

    // Verify TOTP first
    const [totpRecord] = await db
        .select()
        .from(totpSecrets)
        .where(
            and(
                eq(totpSecrets.userId, user.id),
                eq(totpSecrets.verified, true)
            )
        );

    if (!totpRecord) {
        return c.json({ error: 'TOTP not enabled' }, 400);
    }

    const isValid = verify({ secret: totpRecord.secret, token: code });

    if (!isValid) {
        return c.json({ error: 'Invalid code' }, 401);
    }

    // Delete old recovery codes
    await db.delete(recoveryCode).where(eq(recoveryCode.userId, user.id));

    // Generate new ones
    const codes = generateRecoveryCodes();
    const now = new Date();

    for (const recoveryCodeValue of codes) {
        const hashed = await Bun.password.hash(recoveryCodeValue);
        await db.insert(recoveryCode).values({
            id: generateId(15),
            userId: user.id,
            codeHash: hashed,
            used: false,
            createdAt: now,
        });
    }

    return c.json({
        success: true,
        recoveryCodes: codes,
    });
});

export default auth