### Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Install server dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Install client dependencies
COPY client/package.json client/package-lock.json* ./client/
RUN npm install --prefix client

# Copy source and build
COPY . .
RUN npm run build

# Remove dev dependencies for slimmer runtime image
RUN npm prune --omit=dev

### Runtime stage
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Copy runtime files from builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/client/dist ./client/dist

# Ensure data directory exists for runtime writes
RUN mkdir -p /app/server/data
VOLUME ["/app/server/data"]

EXPOSE 4000
CMD ["node", "server/index.js"]
