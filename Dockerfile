FROM node:20-alpine

WORKDIR /app

# Install dependencies (cached layer — only re-runs when package.json changes)
COPY package*.json ./
RUN npm install --omit=dev

# Copy source files explicitly — avoids Docker layer cache missing subdirectories
COPY server.js   ./
COPY auth.js     ./
COPY db.js       ./
COPY routes/     ./routes/
COPY sockets/    ./sockets/
COPY public/     ./public/

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 8080
CMD ["node", "server.js"]
