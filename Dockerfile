# The Registry container — one image, three entrypoints (§23).
#
# Runs TypeScript directly via Node 22's type stripping, exactly as development
# does: no build step means no way for the built artifact to differ from what
# the 332 tests exercised. The default command is the authoritative host
# (authoring + resolution, §4.4); the migrate/seed/import Job overrides it.

FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# All dependencies, not --omit=dev: the migrate Job needs node-pg-migrate,
# and the image is small either way.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src
# The Phase 0 corpus rides along so the import Job can run it (§10.4).
COPY test/fixtures ./test/fixtures

# In a cluster, binding loopback would make the pod unreachable. The manifest
# sets this; the default here documents it.
ENV BIND_HOST=0.0.0.0
EXPOSE 8082

USER node
CMD ["node", "--experimental-strip-types", "src/authoritative-server.ts"]
