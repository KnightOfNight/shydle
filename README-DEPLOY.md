# SHYDLE Deployment

This project deploys to a local Kubernetes cluster (k3s via Rancher Desktop). Nothing is deployed by default: `make deploy` publishes the game, `make nuke` tears it down.

## Deploy

```bash
make deploy
```

That does three things:

- builds a fresh image tagged with a 12-character content hash of the page sources (`index.html.in`, `script.js`, `styles.css`, `words.json`)
- applies `k8s/deployment.yaml` (updated to the new image tag) and `k8s/service.yaml`
- restarts the Deployment so the new pods pick up the image

The Docker build clones the upstream `main` branch from GitHub, so commit and push before running `make deploy`. To deploy from the local working tree instead, use:

```bash
make deploy-local
```

## What runs in the cluster

- 2 pods
- a `LoadBalancer` Service
- HTTP on port `8080` mapped to Nginx port `80`

## Teardown

```bash
make nuke
```

Removes the Deployment, the Service, and every local `shydle` Docker image, regardless of tag. Safe to run repeatedly; it is a no-op when nothing is deployed.

## Notes

- The final image copies only the runtime files needed by Nginx.
- `make deploy` is the normal path for publishing a new page version.
