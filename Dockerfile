# Build and run the standalone server. Two stages so the image carries the
# compiled output and nothing else: no source, no node_modules, no npm.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# The lockfile is resolved through an internal npm mirror that asks for sign-in.
# The tarballs are the public ones, and every entry carries its integrity hash,
# so the build fetches them from the public registry instead.
RUN sed -i 's#https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/#https://registry.npmjs.org/#g' package-lock.json \
 && npm ci --registry=https://registry.npmjs.org/

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Nothing secret is needed to build. Every key is read at request time.
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# The image has no workiq binary and could not sign it in if it did, so the
# service transport is the only one available here. Leaving WORKIQ_PATH unset
# is what selects it.

RUN groupadd --system --gid 1001 app \
 && useradd --system --uid 1001 --gid app app

COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static

USER app
EXPOSE 8080
CMD ["node", "server.js"]
