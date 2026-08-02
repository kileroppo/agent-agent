FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY src /app/src

ENV PYTHONPATH=/app/src
ENV BOOM_DATA_DIR=/data
ENV BOOM_IMPORT_DIR=/data/import

EXPOSE 8000
CMD ["uvicorn", "boom_monitor.main:app", "--host", "0.0.0.0", "--port", "8000"]
