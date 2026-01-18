import { defineConfig } from 'drizzle-kit'

export default defineConfig({
    schema: ['./src/auth/schema.ts', './src/app/schema.ts'],
    out: './drizzle',
    dialect: 'sqlite',
    dbCredentials: {
        url: process.env.DATABASE_PATH || './data/bananadoro.db',
    },
})