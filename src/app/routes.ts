// src/app/routes.ts
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { lucia } from '../index'
import { db } from '../db'
import { userSettings, userSessions } from './schema'

const app = new Hono()

app.get('/settings', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName)
    if (!sessionId) return c.json(null)

    const { session, user } = await lucia.validateSession(sessionId)
    if (!session) return c.json(null)

    const [settings] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, user.id))

    return c.json(settings ?? null)
})

app.post('/settings', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName)
    if (!sessionId) return c.json({ error: 'Not logged in' }, 401)

    const { session, user } = await lucia.validateSession(sessionId)
    if (!session) return c.json({ error: 'Not logged in' }, 401)

    const { workDuration, breakDuration, soundEnabled, notificationsEnabled } = await c.req.json()

    await db.insert(userSettings)
        .values({
            userId: user.id,
            workDuration,
            breakDuration,
            soundEnabled,
            notificationsEnabled,
            updatedAt: new Date()
        })
        .onConflictDoUpdate({
            target: userSettings.userId,
            set: {
                workDuration,
                breakDuration,
                soundEnabled,
                notificationsEnabled,
                updatedAt: new Date()
            }
        })

    return c.json({ success: true })
})

app.get('/session', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName)
    if (!sessionId) return c.json(null)

    const { session, user } = await lucia.validateSession(sessionId)
    if (!session) return c.json(null)

    const [userSession] = await db
        .select()
        .from(userSessions)
        .where(eq(userSessions.userId, user.id))

    return c.json(userSession?.sessionCode ?? null)
})

app.post('/session', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName)
    if (!sessionId) return c.json({ error: 'Not logged in' }, 401)

    const { session, user } = await lucia.validateSession(sessionId)
    if (!session) return c.json({ error: 'Not logged in' }, 401)

    const { sessionCode } = await c.req.json()

    await db.insert(userSessions)
        .values({
            userId: user.id,
            sessionCode,
            updatedAt: new Date()
        })
        .onConflictDoUpdate({
            target: userSessions.userId,
            set: {
                sessionCode,
                updatedAt: new Date()
            }
        })

    return c.json({ success: true })
})

app.delete('/data', async (c) => {
    const sessionId = getCookie(c, lucia.sessionCookieName)
    if (!sessionId) return c.json({ error: 'Not logged in' }, 401)

    const { session, user } = await lucia.validateSession(sessionId)
    if (!session) return c.json({ error: 'Not logged in' }, 401)

    // Delete app data only
    await db.delete(userSettings).where(eq(userSettings.userId, user.id))
    await db.delete(userSessions).where(eq(userSessions.userId, user.id))

    return c.json({ success: true })
})

export default app