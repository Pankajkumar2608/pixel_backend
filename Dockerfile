FROM oven/bun:1.1-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY . .

RUN addgroup -S agent && adduser -S agent -G agent
RUN mkdir -p /app/logs && chown -R agent:agent /app/logs

USER agent

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
