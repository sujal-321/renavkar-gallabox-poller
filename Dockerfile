FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY index.js message_utils.js state_store.js keyed_queue.js ai_agent.js debouncer.js sheets_logger.js outbound_dispatcher.js discord_alerter.js supabase_memory.js ./
CMD ["node", "index.js"]
