import { Discord } from 'arctic'

export interface DiscordOAuthConfig {
    clientId: string
    clientSecret: string
    redirectUri: string
}

export function createDiscordOAuth(config: DiscordOAuthConfig) {
    return new Discord(
        config.clientId,
        config.clientSecret,
        config.redirectUri
    )
}