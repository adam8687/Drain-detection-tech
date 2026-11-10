FROM node:24-bookworm-slim
WORKDIR /app/backend
COPY --chown=node:node backend/package.json ./
COPY --chown=node:node backend/src ./src
COPY --chown=node:node backend/docs ./docs
COPY --chown=node:node supabase/functions/_shared /app/supabase/functions/_shared
RUN mkdir /app/backend/data && chown node:node /app/backend/data
USER node
ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["node", "src/server.js"]
