import { Lucia } from 'lucia'
import { DrizzleSQLiteAdapter} from "@lucia-auth/adapter-drizzle";
import {sessions, users} from "./schema";

export function createLucia(db: any) {
    const adapter = new DrizzleSQLiteAdapter(db, sessions, users)

    return new Lucia(adapter, {
        sessionCookie: {
            attributes: {
                secure: process.env.NODE_ENV === 'production'
            }
        },
        getUserAttributes: (attributes) => {
            return {
                email: attributes.email
            }
        }
    })
}

declare module 'lucia' {
    interface Register {
        Lucia: ReturnType<typeof createLucia>
        DatabaseUserAttributes: {
            email: string | null
        }
    }
}