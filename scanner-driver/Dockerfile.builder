FROM emscripten/emsdk:3.1.50@sha256:b6ea0e55fdc95be36427df6df7892d5e5e27f0440cfcf442a55f784aba09a4fa
RUN apt-get update && apt-get install -y --no-install-recommends automake autoconf autoconf-archive autopoint libtool gettext pkg-config
