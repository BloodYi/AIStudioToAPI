# Claw Cloud Run deployment (historical entry)

This page previously described deployment of upstream prebuilt images. This independently maintained version uses local source builds; the old instructions are no longer the deployment procedure for this version.

Follow the [local Docker build instructions](../../README_EN.md#local-docker-build) or use [docker-compose.yml](../../docker-compose.yml).

To deploy to a platform that accepts custom images, build locally, push to your own registry, and configure registry access, environment variables and persistent volumes according to the platform documentation. `aistudio-to-api:local` is a local tag and cannot be pulled directly by a cloud platform.

Persist `/app/configs/auth` and `/app/data`, and configure your own API keys and console password. Consult current official platform documentation for availability and resource limits.
