# Multi-stage build: compile TypeScript, then ship only the compiled
# output and production dependencies. Used both by `docker-compose.yml`
# (local container smoke-testing) and the Fly.io deploy target.

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 5001
CMD ["node", "dist/index.js"]
