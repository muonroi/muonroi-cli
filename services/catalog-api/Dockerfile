# Muonroi model catalog API.
#
# Build context MUST be the muonroi-cli repo root so the canonical
# src/models/catalog.json can be copied in (single source-of-truth — no
# duplicated catalog file lives in this service directory).
#
#   docker build -f services/catalog-api/Dockerfile -t muonroi-catalog .
#
FROM python:3.12-slim

WORKDIR /app

# Deps first for layer caching.
COPY services/catalog-api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code.
COPY services/catalog-api/main.py .

# Canonical catalog (source-of-truth from the CLI repo).
COPY src/models/catalog.json /app/catalog.json
ENV CATALOG_JSON_PATH=/app/catalog.json

EXPOSE 8083

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8083/health').status==200 else 1)" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8083"]
