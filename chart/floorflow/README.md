# FloorFlow Helm Chart

Helm chart for deploying the FloorFlow shared desk reservation app. It bundles the Node/Express API, React client, and a ConfigMap with the default `seats.json` that seeds the application data on first start.

## Prerequisites

- Helm 3.9+
- Kubernetes 1.24+ with a default StorageClass (if `persistence.enabled=true`)
- A container image for FloorFlow published to a registry reachable by the cluster

## Quick start

```bash
# Adjust the image repository/tag to point at your build
helm upgrade --install floorflow ./chart/floorflow \
  --set image.repository=my-registry.example.com/floorflow \
  --set image.tag=v1.0.0
```

Check the NOTES that Helm prints for port-forwarding or Ingress access instructions.

### Upgrading

Update any overrides and run:

```bash
helm upgrade floorflow ./chart/floorflow -f my-values.yaml
```

### Uninstalling

```bash
helm uninstall floorflow
```

PersistentVolumeClaims are not removed automatically. Delete them manually if you no longer need saved bookings.

## Configuration reference

Override values with `--set` or `-f my-values.yaml`.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `replicaCount` | Number of application pods | `1` |
| `image.repository` | Container image repository | `floorflow` |
| `image.tag` | Image tag | `latest` |
| `image.pullPolicy` | Image pull policy | `IfNotPresent` |
| `imagePullSecrets` | List of secrets for private registries | `[]` |
| `service.type` | Kubernetes Service type | `ClusterIP` |
| `service.port` | Service port exposed inside the cluster | `80` |
| `service.targetPort` | Container port the app listens on | `4000` |
| `ingress.enabled` | Enable creation of an Ingress resource | `false` |
| `ingress.className` | Ingress class to use | `""` |
| `ingress.annotations` | Extra annotations for the Ingress | `{}` |
| `ingress.hosts` | Host/path rules for the Ingress | `[{ host: floorflow.local, paths: [{ path: "/", pathType: Prefix }] }]` |
| `ingress.tls` | TLS configuration list | `[]` |
| `persistence.enabled` | Provision a PersistentVolumeClaim for `/app/server/data` | `true` |
| `persistence.accessModes` | PVC access modes | `["ReadWriteOnce"]` |
| `persistence.size` | Requested storage size | `1Gi` |
| `persistence.storageClass` | StorageClass name (empty uses cluster default) | `""` |
| `resources` | Pod resource requests/limits | `{}` |
| `env` | Extra environment variables (`[{ name: "KEY", value: "VALUE" }]`) | `[]` |
| `admin.create` | Create a Secret with the admin password | `false` |
| `admin.password` | Plain password to place in the generated Secret (requires `admin.create=true`) | `""` |
| `admin.existingSecret` | Reference an existing Secret that contains the password | `""` |
| `admin.secretKey` | Key name inside the existing Secret | `password` |
| `nameOverride` | Override the chart name | `""` |
| `fullnameOverride` | Override the release full name | `""` |

### Admin password handling

Edit mode in the UI is protected by the `ADMIN_PASSWORD` environment variable.

- Set `admin.create=true` and `admin.password=...` to let the chart create a Secret automatically (suitable for demos).
- For production, create a Secret yourself and set `admin.existingSecret` and (if needed) `admin.secretKey`. Example:

  ```bash
  kubectl create secret generic floorflow-admin --from-literal=password='super-secret'

  helm upgrade --install floorflow ./chart/floorflow \
    --set image.repository=my-registry/floorflow \
    --set admin.existingSecret=floorflow-admin
  ```

If neither option is provided, edit mode stays open to all users.

### Persistence and seat bootstrap data

Bookings, seats, and logs are stored under `/app/server/data`:

- When `persistence.enabled=true`, the chart provisions a PVC named `<release>-floorflow-data` so data survives pod restarts.
- When disabled, an `emptyDir` volume is used and all data resets on pod recreation.

An init container copies `chart/floorflow/files/seats.json` into the data directory the first time the pod starts (or whenever `seats.json` is missing). Update that file before packaging or running `helm upgrade` to ship different default seats. After the application writes its own `seats.json`, subsequent upgrades keep the PVC content intact.

### Additional environment variables

Populate the `env` list with entries shaped like:

```yaml
env:
  - name: VITE_API_BASE_URL
    value: https://floorflow.example.com/api
```

Each item becomes a `name`/`value` pair in the container environment.
