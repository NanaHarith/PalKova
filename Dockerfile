# Web build, then the Python app. SQLite lives on a mounted volume (DATABASE_PATH points into it).
FROM node:20-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ARG VITE_AG_GRID_LICENSE=""
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY app/ app/
COPY config/ config/
COPY scripts/ scripts/
# paypal-agent-toolkit goes in --no-deps: a normal install downgrades openai.
RUN pip install --no-cache-dir . && pip install --no-cache-dir --no-deps paypal-agent-toolkit==1.11.0
COPY --from=web /web/dist web/dist
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
