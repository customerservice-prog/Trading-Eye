FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN npm run check
ENV NODE_ENV=production
EXPOSE 80
CMD ["npm","start"]
