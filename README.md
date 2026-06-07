# Bananadoro

A server-first Pomodoro timer with multi-client support.

## About

WebSocket-based Pomodoro timer backend built with Bun and TypeScript. Designed to support web, desktop, and mobile clients.

## Status

✅ Released v1.1.0

## Tech Stack

- Runtime: Bun
- Language: TypeScript
- Protocol: WebSocket

## Features
- 25min work / 5min break modes
- Sound effects and notifications
- User sessions - sync across devices
- Desktop app (Windows)
- Mobile app (Android)

## Usage

### Web
Visit [bananadoro.bananalabs.cloud](https://bananadoro.bananalabs.cloud)

### Desktop & Mobile
Download from [Releases](https://github.com/SirNiklas9/Bananadoro/releases)

### Self-host (Docker)
```bash
docker pull ghcr.io/sirniklas9/bananadoro:latest
docker run -d --name bananadoro -p 3000:3000 ghcr.io/sirniklas9/bananadoro:latest
```

## License

Proprietary - All rights reserved.