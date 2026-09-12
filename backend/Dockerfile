FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    GDAL_HTTP_MULTIRANGE=YES \
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libexpat1 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py clip_pipeline.py ./
COPY elevation_pipeline.py ./
ENV MPLBACKEND=Agg

CMD exec uvicorn app:app --host 0.0.0.0 --port ${PORT}
