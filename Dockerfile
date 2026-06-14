# Final Production Server (Express API only)
FROM node:20-alpine
WORKDIR /app

# Install backend dependencies
# We copy from the 'backend' folder at the root
COPY backend/package*.json ./
RUN npm install --production

# Copy backend source code
COPY backend/ ./

# Environment variables
ENV PORT=8080
ENV NODE_ENV=production

# Railway usually injects its own PORT
EXPOSE 8080

# Start the API server - the main file is in src/server.js
CMD ["node", "src/server.js"]
