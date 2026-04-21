# SHYDLE Deployment

This project is deployed with Kubernetes.

## Deploy

```bash
make deploy
```

That does three things:

- builds a fresh image tagged with the current Unix epoch
- deploys that tagged image to Kubernetes
- restarts the Deployment so the new pods pick up the current upstream `main` branch, the master version of the page

## What runs in the cluster

- 2 pods
- a `LoadBalancer` Service
- HTTP on port `8080` mapped to Nginx port `80`

## Notes

- The Docker build still clones the upstream `main` branch.
- The final image copies only the runtime files needed by Nginx.
- `make deploy` is the normal path for publishing a new page version.
