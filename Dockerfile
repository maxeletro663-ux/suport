FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json .
COPY src ./src
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
