# FloorFlow - shared desk reservation app

FloorFlow renders an interactive office floor plan so teammates can reserve shared desks. The backend runs on Node.js/Express with JSON file persistence, and the frontend is built with React (Vite + TypeScript).

## Getting started

```bash
# install server dependencies
npm install

# install client dependencies
npm install --prefix client

# 1) start the API server (port 4000)
npm run dev

# 2) start the React app in another terminal (port 5173)
npm run client

# development runs on http://localhost:5173 (proxy <-> http://localhost:4000/api)
```

### Production build

```bash
# builds the frontend into client/dist/
npm run build

# starts the Express server that serves the API and static build
npm start
```

## Project structure

- `server/index.js` - Express API with a lightweight JSON-backed reservation store
- `server/data/seats.json` - definition of every shared seat (coordinates in percent for the floor plan)
- `server/data/bookings.json` - current bookings (created automatically)
- `client/src/App.tsx` - React application with the interactive map and sidebar
- `client/public/floorplan.png` - placeholder office floor plan image

## Editing the floor plan and seats

1. Replace `client/public/floorplan.png` with your actual floor plan (recommended resolution ~1600x900).
2. Run the app and toggle **Edit mode** in the top right corner. The editor lets you:
   - drag existing seats to adjust their coordinates,
   - add a new seat (click the map and fill in the form),
   - update the label, zone, or note,
   - tweak **Map zoom** and marker size for precise placement,
   - remove a seat when it is no longer needed.

   All changes are saved to `server/data/seats.json`.
3. Prefer manual editing? Modify the JSON file directly. Each record contains:
   - `id` / `label` - unique identifier (for example `35-4`)
   - `x`, `y` - coordinates in percent (0-100) relative to the floor plan image
   - `zone`, `notes` - optional metadata for grouping and notes

Bookings are stored in `server/data/bookings.json`. You usually do not need to touch the file by hand.

## API overview

| Method | Path                       | Description                                                     |
|--------|----------------------------|-----------------------------------------------------------------|
| GET    | `/api/seats`               | Returns the list of all seats                                   |
| POST   | `/api/seats`               | Creates a new seat (used by the editor)                         |
| PUT    | `/api/seats/:seatId`       | Updates the parameters of an existing seat                      |
| DELETE | `/api/seats/:seatId`       | Removes a seat if it has no active bookings                     |
| GET    | `/api/bookings?date=...`   | Returns bookings for the selected date (`YYYY-MM-DD`)           |
| POST   | `/api/bookings`            | Creates a booking `{ seatId, date, userName }`                  |
| DELETE | `/api/bookings/:bookingId` | Cancels an existing booking                                     |

## Future improvement ideas

- Authentication and permissions (who can cancel someone else's booking).
- Calendar integration (Outlook/Google) or Excel import.
- Weekly or monthly availability overview.
- Store data in a real database (PostgreSQL, SQLite, ...).
- Bulk seat import/export (CSV, Excel) and change history.

---

> Tip: set the `VITE_API_BASE_URL` variable in `client/.env` if the backend runs on another address.

## Ready for GitHub

- `.gitignore` excludes `node_modules`, build outputs, and local `.env` files.
- `client/.env.example` documents how to configure `VITE_API_BASE_URL`.
- `server/data/bookings.json` starts empty and is populated on first use.
- To publish:
  ```bash
  git init
  git add .
  git commit -m "Initial commit"
  git remote add origin <your-repository>
  git push -u origin main
  ```

## Docker

```bash
# build image
docker build -t floorflow:latest .

# run locally (optional persistence)
docker run -p 4000:4000 \
  -v $(pwd)/server/data:/app/server/data \
  floorflow:latest
```

## Helm chart

A basic chart lives in `chart/floorflow`.

```bash
helm install floorflow ./chart/floorflow \
  --set image.repository=<your-registry>/floorflow \
  --set image.tag=latest

# disable the PVC if you prefer ephemeral data
helm install floorflow ./chart/floorflow --set persistence.enabled=false
```

Upload the default seats to a ConfigMap before installing (the init container copies them into the PVC).

The chart also ships with a `seats-data` ConfigMap containing `chart/floorflow/files/seats.json`. Mirror seat edits to this file (and optionally to `server/data/seats.json` for local development) and redeploy with `helm upgrade`.

### Edit mode password

Protect edit mode by setting the `ADMIN_PASSWORD` environment variable:

- **Docker**: add `-e ADMIN_PASSWORD="super-secret"` to `docker run`.
- **Helm**: create a Secret and pass it to the chart:
  ```bash
  kubectl create secret generic floorflow-admin --from-literal=password="super-secret"

  helm upgrade --install floorflow ./chart/floorflow \
    --set image.repository=<your-registry>/floorflow \
    --set image.tag=latest \
    --set admin.existingSecret=floorflow-admin
  ```

Without a password, edit mode is accessible to every user.

## License

[MIT](./LICENSE)
