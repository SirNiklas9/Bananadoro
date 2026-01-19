/**
 * @bananalabs/auth
 *
 * Routes: /auth/*
 * UI: /auth/ui/*
 */

import { Hono } from 'hono';
import { createLucia } from './lucia';
import { createDiscordOAuth } from './oauth';
import { createRoutes } from "./routes";

export interface AuthConfig {
    db: any;
    email?: (to: string, code: string) => Promise<void>;
    oauth?: {
        discord?: {
            clientId: string;
            clientSecret: string;
            redirectUri: string;
        };
    };
    uiPath?: string;  // Optional: where UI files live
}

export function createAuth(config: AuthConfig) {
    const lucia = createLucia(config.db);
    const discord = config.oauth?.discord
        ? createDiscordOAuth(config.oauth.discord)
        : null;

    const routes = createRoutes({
        db: config.db,
        lucia,
        sendEmail: config.email,
        discord,
    });


    const auth = new Hono();

    // Serve UI static files
    if (config.uiPath) {
        auth.get('/ui/:file', async (c) => {
            const file = c.req.param('file');
            if (!/\.(js|css)$/.test(file)) return c.notFound();

            try {
                // Bun.file works with relative paths from project root
                const content = await Bun.file(`${config.uiPath}/${file}`).text();
                const type = file.endsWith('.css') ? 'text/css' : 'application/javascript';
                return c.body(content, 200, {'Content-Type': type});
            } catch {
                return c.notFound();
            }
        });
    }

    // API routes
    auth.route('/', routes);

    return {
        routes: () => auth,
        lucia,
    };
}

export * from './schema';
export { AuthComponent, AuthAPI, AuthState } from './ui/core.js';