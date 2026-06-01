# syntax=docker/dockerfile:1.7

# Stage 1: build the Vite/Vue course site and assemble the runtime payload.
# build-course-site.mjs reads every module-*/{starter,solution} dir, so we need
# the whole repo here. The result is staged into /runtime-app with only what the
# server needs at runtime: the runner, the module sources it streams into Daytona
# sandboxes, the runtime package.json it uploads, tsconfig, and the built site.
FROM node:20-bookworm-slim AS builder
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run course:build \
 && mkdir -p /runtime-app/course/runtime /runtime-app/course-dist \
 && cp -r module-* tsconfig.json package.json package-lock.json scripts /runtime-app/ \
 && cp -r course/runtime/. /runtime-app/course/runtime/ \
 && cp -r course/dist/. /runtime-app/course-dist/

# Stage 2: runtime image. A single Node process serves the built site and the
# /api/* endpoints from the same origin (see COURSE_DIST_DIR in the runner).
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    COURSE_DIST_DIR=/app/course-dist
COPY --from=builder /runtime-app ./
RUN npm ci --omit=dev
EXPOSE 8080
CMD ["npm", "start"]
