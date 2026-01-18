/**
 * @bananalabs/auth
 *
 * Routes: /auth/*
 * UI: /auth/ui/*
 */

import { Hono } from 'hono';
import routes from './routes';

const auth = new Hono();

// Serve UI static files
auth.get('/ui/:file', async (c) => {
    const file = c.req.param('file');
    if (!/\.(js|css)$/.test(file)) return c.notFound();

    try {
        // Bun.file works with relative paths from project root
        const content = await Bun.file(`./src/auth/ui/${file}`).text();
        const type = file.endsWith('.css') ? 'text/css' : 'application/javascript';
        return c.body(content, 200, { 'Content-Type': type });
    } catch {
        return c.notFound();
    }
});

// API routes
auth.route('/', routes);

export default auth;
export { auth as authRoutes };
