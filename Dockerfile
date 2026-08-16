# Builds both workspaces, then ships only the backend's compiled output
# plus the frontend's static build — the backend serves both from one
# origin (see backend/src/app.ts) so auth cookies and Socket.IO work
# without cross-origin config. docs/free-tier-plan.md §7.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist

ENV PORT=8000
EXPOSE 8000
CMD ["node", "backend/dist/index.js"]
