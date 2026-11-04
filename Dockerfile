FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS ui
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
RUN npm run build:app

FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_THREAD_LIMIT=2 OPENBLAS_NUM_THREADS=1 \
    APP_PUBLIC_URL=http://localhost:8000 STATE_DIR=/state WORK_DIR=/work ARCHIVE_DIR=/archive OCR_ENABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra tesseract-ocr-jpn tesseract-ocr-chi-tra tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY server ./server
COPY raw-scanner.mjs ./
COPY scanner-driver/build ./scanner-driver/build
RUN python -c 'import hashlib,json,pathlib; p=pathlib.Path("scanner-driver/build"); m=json.loads((p/"provenance.json").read_text()); assert m["patch_revision"]=="receipt-longpaper-2"; assert all(hashlib.sha256((p/n).read_bytes()).hexdigest()==h for n,h in m["sha256"].items())'
COPY --from=ui /app/web/build ./web/build
RUN groupadd --gid 10001 receipt && useradd --uid 10001 --gid receipt --no-create-home receipt \
    && mkdir /state /work /samples /archive && chown receipt:receipt /state /work /samples /archive
USER 10001:10001
VOLUME ["/state", "/work", "/samples", "/archive"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD python -c 'import os,time,urllib.request; from pathlib import Path; req=urllib.request.Request("http://127.0.0.1:8000/api/health",headers={"Host":__import__("urllib.parse",fromlist=["urlsplit"]).urlsplit(os.environ["APP_PUBLIC_URL"]).netloc}); assert urllib.request.urlopen(req,timeout=3).status==200; assert time.time()-float(Path("/state/worker-heartbeat").read_text())<600'
CMD ["python", "-m", "server.run"]
