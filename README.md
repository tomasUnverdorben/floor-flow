# FloorFlow – Shared Desk Reservation App

![FloorFlow logo](images/logo_git_readme.png)

**FloorFlow** is a lightweight office desk reservation system with an interactive floor plan.  
The **backend** runs on **Node.js/Express** (JSON-based persistence), and the **frontend** is built with **React + Vite + TypeScript**.

---

## 🚀 Getting Started

```bash
# install server dependencies
npm install

# install client dependencies
npm install --prefix client

# start API server (port 4000)
npm run dev

# in another terminal, start the React app (port 5173)
npm run client
```

Access the app at **http://localhost:5173**  
(proxied to **http://localhost:4000/api**).

---

## 🏗️ Production Build

```bash
# build the frontend into client/dist/
npm run build

# start the Express server serving both API and static files
npm start
```

---

## 📂 Project Structure

| Path | Description |
|------|--------------|
| `server/index.js` | Express API with JSON-backed reservation storage |
| `server/data/seats.json` | Seat definitions (coordinates and metadata) |
| `server/data/bookings.json` | Active bookings (auto-created) |
| `client/src/App.tsx` | React app with interactive map and sidebar |
| `client/public/floorplan.png` | Default office floor plan image |

---

## 🗺️ Editing the Floor Plan & Seats

1. Replace `client/public/floorplan.png` with your real office layout (recommended: ~1600×900).
2. Run the app and toggle **Edit mode** in the top-right corner to:
   - drag and reposition seats,
   - add new seats,
   - update labels, zones, or notes,
   - adjust map zoom and marker size,
   - or remove obsolete seats.

   Changes are saved automatically to `server/data/seats.json`.

3. Alternatively, edit the JSON file manually. Each seat entry includes:
   ```json
   {
     "id": "35-4",
     "label": "35-4",
     "x": 47.2,
     "y": 63.5,
     "zone": "North",
     "notes": "Near window"
   }
   ```

Bookings are stored in `server/data/bookings.json` — no manual editing required.

---

## 📡 API Overview

| Method | Endpoint | Description |
|--------|-----------|-------------|
| GET | `/api/seats` | Get all seats |
| POST | `/api/seats` | Create new seat |
| PUT | `/api/seats/:seatId` | Update existing seat |
| DELETE | `/api/seats/:seatId` | Remove a seat (if unbooked) |
| GET | `/api/bookings?date=YYYY-MM-DD` | Get bookings for a date |
| POST | `/api/bookings` | Create booking `{ seatId, date, userName, recurrence?, skipConflicts? }` |
| POST | `/api/bookings/preview` | Preview availability and suggestions |
| DELETE | `/api/bookings/:bookingId` | Cancel a single booking |
| DELETE | `/api/bookings/series/:seriesId` | Cancel all future bookings in a series |

### 🔁 Recurring Bookings
- Supported via UI or API (`daily` / `weekly` up to 52 occurrences)
- Default behavior: **all-or-nothing**
- Use `skipConflicts: true` to only create free dates
- Each booking returns a `seriesId` for easy bulk cancellation

---

## 💡 Future Ideas

- Authentication & permissions (limit who can edit/cancel)
- Calendar sync (Outlook/Google)
- Weekly/monthly availability overview
- Database backend (PostgreSQL/SQLite)
- CSV/Excel seat import/export + change history

---

## ⚙️ Configuration Tips

Set custom backend URL:
```bash
# client/.env
VITE_API_BASE_URL=http://your-api:4000
```

---

## 🐳 Docker

```bash
# build image
docker build -t floorflow:latest .

# run locally with persistent data
docker run -p 4000:4000   -v $(pwd)/server/data:/app/server/data   floorflow:latest
```

---

## ⎈ Helm Chart

A basic Helm chart is located at `chart/floorflow`.

```bash
helm install floorflow ./chart/floorflow   --set image.repository=<your-registry>/floorflow   --set image.tag=latest
```

Disable persistent storage if you prefer ephemeral data:
```bash
helm install floorflow ./chart/floorflow --set persistence.enabled=false
```

> The chart includes a `seats-data` ConfigMap that preloads `seats.json`.  
> To update it, edit the JSON and redeploy via `helm upgrade`.

---

### 🔒 Edit Mode Password

Protect the floor plan editor:

**Docker**
```bash
docker run -e ADMIN_PASSWORD="super-secret" ...
```

**Helm**
```bash
kubectl create secret generic floorflow-admin   --from-literal=password="super-secret"

helm upgrade --install floorflow ./chart/floorflow   --set admin.existingSecret=floorflow-admin
```

Without a password, everyone can edit seats.

---

## 🧾 License

[MIT License](./LICENSE)
