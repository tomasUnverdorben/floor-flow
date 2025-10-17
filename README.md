# 🏢 FloorFlow – Shared Desk Reservation App

![FloorFlow logo](images/logo_git_readme.png)

![License](https://img.shields.io/github/license/tomasUnverdorben/floor-flow)
![Last Commit](https://img.shields.io/github/last-commit/tomasUnverdorben/floor-flow)
![Issues](https://img.shields.io/github/issues/tomasUnverdorben/floor-flow)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)
![Stars](https://img.shields.io/github/stars/tomasUnverdorben/floor-flow?style=social)

---

## 💡 Why FloorFlow?

Modern offices are hybrid — desks are shared, not owned.  
**FloorFlow** helps visualize your office layout and lets teammates reserve desks in just a few clicks.

It’s lightweight, open-source, and easy to self-host.

---

## 🛠️ Tech Stack

**Frontend:** React • Vite • TypeScript  
**Backend:** Node.js • Express • JSON Store  
**Deployment:** Docker • Helm • Kubernetes  
**Optional:** Persistent volume storage or ephemeral mode

---

## 🚀 Getting Started

```bash
# install server dependencies
npm install

# install client dependencies
npm install --prefix client

# start API server (port 4000)
npm run dev

# start API server with mongodb
1. change MONGODB_ENABLED env value in package.json to "true" 
2. docker compose up
3. npm run dev

# in another terminal, start the React app (port 5173)
npm run client
```

Access at **http://localhost:5173** (proxy ↔ `http://localhost:4000/api`).

---

## 🏗️ Production Build

```bash
# build frontend
npm run build

# serve both API and built frontend
npm start
```

---

## 📂 Project Structure

| Path | Description |
|------|--------------|
| `server/index.js` | Express API with JSON-backed reservation store |
| `server/data/seats.json` | Seat definitions (coordinates, metadata) |
| `server/data/bookings.json` | Active bookings (auto-created) |
| `server/data/cancellations.json` | Cancellation log used for analytics |
| `client/src/App.tsx` | React app with interactive map & sidebar |
| `client/public/floorplan.png` | Default floor plan image |

---

## 🗺️ Editing the Floor Plan & Seats

1. Replace `client/public/floorplan.png` with your real layout (~1600×900 recommended).
2. Start the app and toggle **Edit mode** in the top-right corner.
3. You can:
   - drag and reposition seats,
   - add or remove seats,
   - update labels, zones, and notes,
   - fine-tune zoom and marker size.
4. Changes save automatically to `server/data/seats.json`.

Alternatively, edit the JSON directly:
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
| POST | `/api/bookings/preview` | Preview availability |
| DELETE | `/api/bookings/:bookingId` | Cancel a single booking |
| DELETE | `/api/bookings/series/:seriesId` | Cancel a recurring series |
| GET | `/api/analytics/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` | Aggregate booking and cancellation stats |

### 🔁 Recurring Bookings

- Supported via UI or API (`daily` or `weekly`, up to 52 occurrences)
- Default: **all-or-nothing**
- `skipConflicts: true` → only free dates are created
- Each booking returns a `seriesId` for easy cancellation

---

## 👥 Managing Reservations

- The sidebar shows everyone with bookings for the selected day and, in a separate panel, a full list of users with reservations.
- Click a user chip to expand an interactive list of their upcoming bookings — move a single day to another seat or cancel it in one click.
- The cancellation actions are synced with the server and feed into analytics automatically.

---

## 📊 Analytics Dashboard

Need a bigger picture? Click the **Statistics** button next to *Edit mode*.

- Filter by custom start/end dates or use quick ranges (7 / 30 / 90 days, year-to-date).
- See totals for created, active, and cancelled bookings plus the average per day and the number of unique teammates reserving seats.
- Ranked tables highlight the most popular seats, most active users, teammates who cancel most often, and the busiest days in the selected window.

All metrics are powered by `/api/analytics/summary`, which computes aggregates from the JSON data store. Attach the API to BI tooling or export the results if you need deeper reporting.

---

## ⚙️ Configuration Tips

Custom backend URL (for proxy setups):
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

A simple Helm chart is available in `chart/floorflow`:

```bash
helm install floorflow ./chart/floorflow   --set image.repository=<your-registry>/floorflow   --set image.tag=latest
```

Disable persistent storage if you prefer ephemeral data:
```bash
helm install floorflow ./chart/floorflow --set persistence.enabled=false
```

> The chart includes a `seats-data` ConfigMap preloading `seats.json`.  
> Edit it and redeploy via `helm upgrade`.

---

### 🔒 Edit Mode Password

Protect the seat editor with an environment variable:

**Docker**
```bash
docker run -e ADMIN_PASSWORD="super-secret" ...
```

**Helm**
```bash
kubectl create secret generic floorflow-admin   --from-literal=password="super-secret"

helm upgrade --install floorflow ./chart/floorflow   --set admin.existingSecret=floorflow-admin
```

Without a password, edit mode is open to all users.

---

## 💡 Future Ideas

- Authentication & roles (admin / user)
- Calendar sync (Outlook, Google)
- Weekly/monthly views
- Real DB backend (PostgreSQL, SQLite)
- CSV/Excel seat import & version history

---

## 🤝 Contributing

Pull requests are welcome!  
For major changes, open an issue first to discuss what you’d like to improve.

```bash
git clone https://github.com/tomasUnverdorben/floor-flow.git
cd floor-flow
npm install
```

---

## 🧾 License

This project is licensed under the [MIT License](./LICENSE).

---

⭐️ **If you like FloorFlow, give it a star!**  
💬 Have ideas? Open an [issue](../../issues) or join the discussion.
