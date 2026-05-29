FROM node:20-slim

# Build tooling required by native modules (better-sqlite3)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/Backend-Embedded

# Install backend dependencies in a clean Linux environment
COPY Backend-Embedded/package*.json ./
RUN npm install --omit=dev

# Copy backend source
COPY Backend-Embedded/ ./

# Copy frontend so express static path ../Frontend-Embedded resolves
COPY Frontend-Embedded/ /app/Frontend-Embedded/

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
