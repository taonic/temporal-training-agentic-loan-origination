# Bakes config.yaml into the published LiteLLM image so Fly can run it directly.
# Pin to a specific LiteLLM release rather than main-latest for a reproducible
# workshop; bump deliberately.
FROM ghcr.io/berriai/litellm:main-stable

COPY config.yaml /app/config.yaml

# The image's entrypoint is `litellm`; these args append to it.
CMD ["--config", "/app/config.yaml", "--port", "4000"]
