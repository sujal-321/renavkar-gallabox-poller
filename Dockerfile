FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY index.js message_utils.js state_store.js keyed_queue.js ./
CMD ["node", "index.js"]
