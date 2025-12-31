#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "PROJECT_ID is not set and no gcloud config project found."
  echo "Set PROJECT_ID or run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

echo "Using project: ${PROJECT_ID}"
echo "Using region: ${REGION}"

echo "Building API image..."
gcloud builds submit "${ROOT_DIR}/server" \
  --tag "${REGION}-docker.pkg.dev/${PROJECT_ID}/cognitive-calendar/cognitive-api:latest"

echo "Deploying API..."
gcloud run deploy cognitive-api \
  --image "${REGION}-docker.pkg.dev/${PROJECT_ID}/cognitive-calendar/cognitive-api:latest" \
  --region "${REGION}" \
  --allow-unauthenticated

API_URL="$(gcloud run services describe cognitive-api --region "${REGION}" --format='value(status.url)')"
if [[ -z "${API_URL}" ]]; then
  echo "Failed to resolve cognitive-api URL."
  exit 1
fi

echo "API URL: ${API_URL}"
echo "Building web image..."
gcloud builds submit "${ROOT_DIR}/web" \
  --config "${ROOT_DIR}/web/cloudbuild.yaml" \
  --substitutions "_NEXT_PUBLIC_API_BASE=${API_URL},_IMAGE=${REGION}-docker.pkg.dev/${PROJECT_ID}/cognitive-calendar/cognitive-web:latest"

echo "Deploying web..."
gcloud run deploy cognitive-web \
  --image "${REGION}-docker.pkg.dev/${PROJECT_ID}/cognitive-calendar/cognitive-web:latest" \
  --region "${REGION}" \
  --allow-unauthenticated

WEB_URL="$(gcloud run services describe cognitive-web --region "${REGION}" --format='value(status.url)')"
echo "Web URL: ${WEB_URL}"
