# Multi-stage build for the NestJS API + in-process BullMQ workers.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig*.json nest-cli.json ./
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# Entrypoint applies migrations (bounded-backoff DB connect handled in-app too),
# then starts the API + workers in one process.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
