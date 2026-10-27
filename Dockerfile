FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node backend/package.json ./
COPY --chown=node:node backend/src ./src
COPY --chown=node:node backend/docs ./docs
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["node", "src/server.js"]
