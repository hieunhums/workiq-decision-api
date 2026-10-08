#!/usr/bin/env bash
# Deploy to Azure Container Apps.
#
# Everything here is idempotent, so rerun it to ship a new build.
#
# Two things this script cannot do for you, both called out at the end:
#   1. Grant the container's identity a role on the Foundry resource. That
#      needs an owner on the subscription.
#   2. Add the app's redirect URI to the sign-in app registration. That needs
#      an owner of the registration.
set -euo pipefail

GROUP=${GROUP:-rg-workiq-decision-api}
LOCATION=${LOCATION:-eastus2}
APP=${APP:-ca-workiq-decision-api}
ENVIRONMENT=${ENVIRONMENT:-cae-workiq-decision-api}
FOUNDRY_HOST=${FOUNDRY_HOST:?set FOUNDRY_HOST to your Azure OpenAI host, e.g. my-foundry.openai.azure.com}
REALTIME_DEPLOYMENT=${REALTIME_DEPLOYMENT:-gpt-realtime-2.1}
USER_TIME_ZONE=${USER_TIME_ZONE:-Asia/Singapore}
USER_COUNTRY=${USER_COUNTRY:-SG}
# Each build gets its own tag, so an update always starts a new revision.
TAG=${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}

if [[ -z "${TYPESAFE_API_KEY:-}" ]]; then
  echo "TYPESAFE_API_KEY is not set. Jev does the routing, so nothing works without it." >&2
  exit 1
fi

# Web IQ is optional. Without a key the model is offered workplace data only.
SECRETS=("typesafe-key=$TYPESAFE_API_KEY")
ENV_VARS=(
  "TYPESAFE_API_KEY=secretref:typesafe-key"
  "FOUNDRY_HOST=$FOUNDRY_HOST"
  "REALTIME_DEPLOYMENT=$REALTIME_DEPLOYMENT"
  "USER_TIME_ZONE=$USER_TIME_ZONE"
  "USER_COUNTRY=$USER_COUNTRY"
)
if [[ -n "${WEBIQ_API_KEY:-}" ]]; then
  SECRETS+=("webiq-key=$WEBIQ_API_KEY")
  ENV_VARS+=("WEBIQ_API_KEY=secretref:webiq-key")
fi

# Sign-in is optional too, but without it nobody's Work IQ can be reached: the
# image has no Work IQ CLI. The redirect URI is set once the app's URL is known.
if [[ -n "${ENTRA_CLIENT_ID:-}" && -n "${ENTRA_CLIENT_SECRET:-}" ]]; then
  SECRETS+=("entra-secret=$ENTRA_CLIENT_SECRET")
  ENV_VARS+=(
    "ENTRA_CLIENT_ID=$ENTRA_CLIENT_ID"
    "ENTRA_CLIENT_SECRET=secretref:entra-secret"
    "ENTRA_TENANT_ID=${ENTRA_TENANT_ID:-organizations}"
  )
fi

say() { printf '\n== %s\n' "$1"; }

say "Resource group $GROUP in $LOCATION"
az group create -n "$GROUP" -l "$LOCATION" -o none

# Reuse the group's registry, so a rerun does not make a new one.
REGISTRY=${REGISTRY:-$(az acr list -g "$GROUP" --query "[0].name" -o tsv 2>/dev/null)}
REGISTRY=${REGISTRY:-workiqdecisionapi$RANDOM}
say "Registry $REGISTRY"
az acr create -g "$GROUP" -n "$REGISTRY" --sku Basic -o none 2>/dev/null || true

say "Building the image in ACR"
# Built for amd64 explicitly. A Mac would otherwise produce an arm64 image that
# Container Apps refuses to start, with an error that does not say why.
az acr build -r "$REGISTRY" --platform linux/amd64 -t "workiq-decision-api:$TAG" . -o none

say "Container Apps environment $ENVIRONMENT"
az containerapp env create -g "$GROUP" -n "$ENVIRONMENT" -l "$LOCATION" -o none 2>/dev/null || true

IMAGE="$REGISTRY.azurecr.io/workiq-decision-api:$TAG"

say "App $APP"
if az containerapp show -g "$GROUP" -n "$APP" -o none 2>/dev/null; then
  az containerapp secret set -g "$GROUP" -n "$APP" --secrets "${SECRETS[@]}" -o none
  az containerapp update -g "$GROUP" -n "$APP" --image "$IMAGE" \
    --set-env-vars "${ENV_VARS[@]}" -o none
else
  az containerapp create -g "$GROUP" -n "$APP" \
    --environment "$ENVIRONMENT" \
    --image "$IMAGE" \
    --target-port 8080 \
    --ingress external \
    --registry-server "$REGISTRY.azurecr.io" \
    --system-assigned \
    --min-replicas 1 \
    --cpu 0.5 --memory 1Gi \
    --registry-identity system \
    --secrets "${SECRETS[@]}" \
    --env-vars "${ENV_VARS[@]}" \
    -o none
fi

# min-replicas 1 is deliberate. Scaling to zero would put a cold start in front
# of a conversation, and the point of the whole design is that answers arrive
# while the person is still listening.

PRINCIPAL=$(az containerapp show -g "$GROUP" -n "$APP" --query identity.principalId -o tsv)
URL=$(az containerapp show -g "$GROUP" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)

if [[ -n "${ENTRA_CLIENT_ID:-}" ]]; then
  az containerapp update -g "$GROUP" -n "$APP" \
    --set-env-vars "AUTH_REDIRECT_URI=https://$URL/api/auth/callback" -o none
fi

cat <<EOF

Deployed:  https://$URL
Identity:  $PRINCIPAL

Two steps remain, both needing someone with more rights than a deployer.

1. Let the app mint realtime sessions. An owner on the Foundry subscription runs:

     az role assignment create \\
       --assignee $PRINCIPAL \\
       --role "Cognitive Services OpenAI User" \\
       --scope <resource id of $FOUNDRY_HOST>

2. Let people sign in. Work IQ has no app-only mode, so the app acts as the
   person signed in on the page. Add this redirect URI to the Web platform of
   the app registration in ENTRA_CLIENT_ID:

     https://$URL/api/auth/callback

   Until then workplace questions answer 401 and ask the person to sign in.
EOF
