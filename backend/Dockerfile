FROM python:3.12-slim

WORKDIR /app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY eval_service.py .

# Config dir — levels.json will be bind-mounted here
RUN mkdir -p /app/config

EXPOSE 8000

CMD ["sh", "-c", "uvicorn eval_service:app --host 0.0.0.0 --port 8000 $([ \"$RELOAD\" = 'true' ] && echo '--reload' || true)"]
