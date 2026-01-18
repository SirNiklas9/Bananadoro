import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
    id: text('id').primaryKey(),
    email: text('email'),
    createdAt: integer('created_at', { mode: 'timestamp'}).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp'}).notNull(),
})

export const sessions = sqliteTable('sessions', {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    expiresAt: integer('expires_at').notNull(),
})

export const oauthAccounts = sqliteTable('oauth_accounts', {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    provider: text('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    providerUsername: text('provider_username'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const nativeAccounts = sqliteTable('native_accounts', {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    email: text('email').notNull().unique(),
    username: text('username'),
    passwordHash: text('password_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const otpCodes = sqliteTable('otp_codes', {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    code: text('code').notNull(),
    type: text('type').notNull(), // 'login' | 'oauth_mobile'
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    metadata: text('metadata'),
})

export const totpSecrets = sqliteTable('totp_secrets', {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    secret: text('secret').notNull(),
    verified: integer('verified', { mode: 'boolean' }).default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Recovery codes for TOTP
export const recoveryCode = sqliteTable('recovery_codes', {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    codeHash: text('code_hash').notNull(), // Stored hashed
    used: integer('used', { mode: 'boolean' }).default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})