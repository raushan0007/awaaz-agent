FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AWAAZ_DATA_DIR=/data

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY frontend ./frontend
COPY demo ./demo

# Hosts like Render pass the port in $PORT. Keys come from the host's secret settings:
# MODEL_API_KEY, BASETEN_API_KEY and (optional) AWAAZ_DEMO_OFFICER_PASSWORD.
EXPOSE 8000
CMD ["sh", "-c", "python -m backend.app.bootstrap && exec uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers"]
