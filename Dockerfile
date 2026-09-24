FROM python:3.12-slim
WORKDIR /app
RUN groupadd --gid 10001 daybook && useradd --uid 10001 --gid daybook --no-create-home daybook \
    && mkdir /data && chown daybook:daybook /data
COPY server.py device_sync.py ./
COPY static/ ./static/
USER daybook
ENV DAYBOOK_DB=/data/daybook.db
EXPOSE 8000
CMD ["python", "server.py"]
