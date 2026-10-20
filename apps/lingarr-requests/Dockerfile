FROM python@sha256:79e7a9b9ff1cbceff819f856fb374477792a5967759d94df266de7b7b4120e6f

WORKDIR /app
COPY app.py /app/app.py
COPY public /app/public
USER 1000:1000
EXPOSE 8080
CMD ["python", "/app/app.py"]
