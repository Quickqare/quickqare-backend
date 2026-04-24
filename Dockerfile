FROM node:20-alpine

WORKDIR /app

# Install prod deps first for better Docker layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

ENV NODE_ENV=production

# Backend uses PORT from .env (default in your .env.example is 4000)
EXPOSE 4000

CMD ["npm", "start"]

