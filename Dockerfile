FROM oven/bun:latest
LABEL authors="Nicholas"

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production

COPY src ./src
COPY public ./public

ENV DATABASE_PATH=/app/data/bananadoro.db

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]