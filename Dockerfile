FROM node:20-alpine

# sql.js uses pure WebAssembly — no C++ build tools needed
WORKDIR /app

# Install dependencies first (layer cache — only re-runs when package.json changes)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Create data directory for SQLite database
RUN mkdir -p /app/data

EXPOSE 8080

CMD ["node", "server.js"]
