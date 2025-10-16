const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { promises: fs } = require("fs");
const { v4: uuid } = require("uuid");

const app = express();
const PORT = process.env.PORT || 4000;

const DATA_DIR = path.join(__dirname, "data");
const SEATS_FILE = path.join(DATA_DIR, "seats.json");
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");
const CLIENT_BUILD_DIR = path.join(__dirname, "..", "client", "dist");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ? String(process.env.ADMIN_PASSWORD) : "";

app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  const line = `[${new Date().toISOString()}] ${req.method} ${req.path}\n`;
  fs.appendFile(path.join(DATA_DIR, "debug.log"), line).catch(() => {
    // ignore logging errors
  });
  next();
});

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const defaultFiles = [
    { file: SEATS_FILE, fallback: "[]" },
    { file: BOOKINGS_FILE, fallback: "[]" }
  ];

  await Promise.all(
    defaultFiles.map(async ({ file, fallback }) => {
      try {
        await fs.access(file);
      } catch (error) {
        if (error.code === "ENOENT") {
          await fs.writeFile(file, fallback, "utf8");
        } else {
          throw error;
        }
      }
    })
  );
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT" && typeof fallback !== "undefined") {
      await writeJson(file, fallback);
      return fallback;
    }
    console.error(`Failed to read ${file}`, error);
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

function normalizeDate(input) {
  if (!input) {
    return null;
  }

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseCoordinate(value) {
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const rounded = Math.round(clamp(numeric, 0, 100) * 1000) / 1000;
  return rounded;
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

app.get("/api/seats", async (_req, res, next) => {
  try {
    const seats = await readJson(SEATS_FILE, []);
    res.json(seats);
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/verify", (req, res) => {
  const headerSecret = extractAdminHeader(req);
  const bodyPassword = typeof req.body?.password === "string" ? req.body.password : "";
  const candidate = headerSecret || bodyPassword;

  if (!isAdminPasswordConfigured()) {
    res.json({ authorized: true, passwordRequired: false });
    return;
  }

  if (candidate && safeCompareString(candidate, ADMIN_PASSWORD)) {
    res.json({ authorized: true, passwordRequired: true });
  } else {
    res.status(401).json({ message: "Password is not valid." });
  }
});

app.post("/api/seats", requireAdmin, async (req, res, next) => {
  try {
    const { id, label, x, y, zone, notes } = req.body || {};
    const normalizedId = normalizeText(id);
    const xCoordinate = parseCoordinate(x);
    const yCoordinate = parseCoordinate(y);

    if (!normalizedId || xCoordinate === null || yCoordinate === null) {
      return res.status(400).json({
        message: "Seat id, x and y are required and must be valid numbers (0-100)."
      });
    }

    const seats = await readJson(SEATS_FILE, []);

    if (seats.some((seat) => seat.id === normalizedId)) {
      return res
        .status(409)
        .json({ message: `Seat with ID "${normalizedId}" already exists.` });
    }

    const newSeat = {
      id: normalizedId,
      label: normalizeText(label) || normalizedId,
      x: xCoordinate,
      y: yCoordinate,
      zone: normalizeText(zone),
      notes: normalizeText(notes)
    };

    const cleanedSeat = Object.fromEntries(
      Object.entries(newSeat).filter(([, value]) => value !== undefined)
    );

    seats.push(cleanedSeat);
    await writeJson(SEATS_FILE, seats);

    res.status(201).json(cleanedSeat);
  } catch (error) {
    next(error);
  }
});

app.put("/api/seats/:seatId", requireAdmin, async (req, res, next) => {
  try {
    const { seatId } = req.params;
    const { label, x, y, zone, notes } = req.body || {};

    const seats = await readJson(SEATS_FILE, []);
    console.log("PUT /api/seats", seatId, "payload", { label, x, y, zone, notes });
    console.log("Available seat IDs", seats.map((seat) => seat.id));
    const seatIndex = seats.findIndex((seat) => seat.id === seatId);

    if (seatIndex === -1) {
      console.log("Seat not found for update", seatId);
      return res.status(404).json({ message: `Seat ${seatId} does not exist.` });
    }

    const seatToUpdate = { ...seats[seatIndex] };

    if (typeof label !== "undefined") {
      const normalizedLabel = normalizeText(label);
      if (!normalizedLabel) {
        return res.status(400).json({ message: "Label must not be empty." });
      }
      seatToUpdate.label = normalizedLabel;
    }

    if (typeof zone !== "undefined") {
      const normalizedZone = normalizeText(zone);
      if (normalizedZone) {
        seatToUpdate.zone = normalizedZone;
      } else {
        delete seatToUpdate.zone;
      }
    }

    if (typeof notes !== "undefined") {
      const normalizedNotes = normalizeText(notes);
      if (normalizedNotes) {
        seatToUpdate.notes = normalizedNotes;
      } else {
        delete seatToUpdate.notes;
      }
    }

    if (typeof x !== "undefined") {
      const parsedX = parseCoordinate(x);
      if (parsedX === null) {
        return res
          .status(400)
          .json({ message: "x must be a number between 0 and 100." });
      }
      seatToUpdate.x = parsedX;
    }

    if (typeof y !== "undefined") {
      const parsedY = parseCoordinate(y);
      if (parsedY === null) {
        return res
          .status(400)
          .json({ message: "y must be a number between 0 and 100." });
      }
      seatToUpdate.y = parsedY;
    }

    seats[seatIndex] = seatToUpdate;
    await writeJson(SEATS_FILE, seats);

    res.json(seatToUpdate);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/seats/:seatId", requireAdmin, async (req, res, next) => {
  try {
    const { seatId } = req.params;
    const seats = await readJson(SEATS_FILE, []);
    const seatIndex = seats.findIndex((seat) => seat.id === seatId);

    if (seatIndex === -1) {
      return res.status(404).json({ message: `Seat ${seatId} does not exist.` });
    }

    const bookings = await readJson(BOOKINGS_FILE, []);
    const hasBookings = bookings.some((booking) => booking.seatId === seatId);

    if (hasBookings) {
      return res.status(409).json({
        message: `Seat ${seatId} has existing bookings. Please cancel them first.`
      });
    }

    const [removedSeat] = seats.splice(seatIndex, 1);
    await writeJson(SEATS_FILE, seats);

    res.json({ removed: removedSeat });
  } catch (error) {
    next(error);
  }
});

app.get("/api/bookings", async (req, res, next) => {
  try {
    const requestedDate = normalizeDate(req.query.date);
    const bookings = await readJson(BOOKINGS_FILE, []);

    if (!requestedDate) {
      res.json(bookings);
      return;
    }

    const filtered = bookings.filter((booking) => booking.date === requestedDate);
    res.json(filtered);
  } catch (error) {
    next(error);
  }
});

app.post("/api/bookings", async (req, res, next) => {
  try {
    const { seatId, date, userName } = req.body || {};
    const trimmedName = typeof userName === "string" ? userName.trim() : "";
    const normalizedDate = normalizeDate(date);

    if (!seatId || !trimmedName || !normalizedDate) {
      return res.status(400).json({
        message: "seatId, date and userName are required and must be valid."
      });
    }

    const [seats, bookings] = await Promise.all([
      readJson(SEATS_FILE, []),
      readJson(BOOKINGS_FILE, [])
    ]);

    const seatExists = seats.some((seat) => seat.id === seatId);
    if (!seatExists) {
      return res.status(404).json({ message: `Seat ${seatId} does not exist.` });
    }

    const alreadyBooked = bookings.find(
      (booking) => booking.seatId === seatId && booking.date === normalizedDate
    );

    if (alreadyBooked) {
      return res.status(409).json({
        message: `Seat ${seatId} is already booked for ${normalizedDate}.`
      });
    }

    const newBooking = {
      id: uuid(),
      seatId,
      date: normalizedDate,
      userName: trimmedName,
      createdAt: new Date().toISOString()
    };

    bookings.push(newBooking);
    await writeJson(BOOKINGS_FILE, bookings);

    res.status(201).json(newBooking);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/bookings/:bookingId", async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    if (!bookingId) {
      return res.status(400).json({ message: "bookingId parameter is required." });
    }

    const bookings = await readJson(BOOKINGS_FILE, []);
    const bookingIndex = bookings.findIndex((booking) => booking.id === bookingId);

    if (bookingIndex === -1) {
      return res.status(404).json({ message: `Booking ${bookingId} not found.` });
    }

    const [removedBooking] = bookings.splice(bookingIndex, 1);
    await writeJson(BOOKINGS_FILE, bookings);

    res.json({ removed: removedBooking });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(CLIENT_BUILD_DIR));
app.use(async (req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) {
    next();
    return;
  }

  try {
    await fs.access(path.join(CLIENT_BUILD_DIR, "index.html"));
    res.sendFile(path.join(CLIENT_BUILD_DIR, "index.html"));
  } catch (error) {
    next();
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: "Unexpected server error." });
});

ensureDataFiles()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
function isAdminPasswordConfigured() {
  return ADMIN_PASSWORD.length > 0;
}

function safeCompareString(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function extractAdminHeader(req) {
  const header = req.headers["x-admin-secret"];
  return typeof header === "string" ? header : "";
}

function requireAdmin(req, res, next) {
  if (!isAdminPasswordConfigured()) {
    next();
    return;
  }

  const provided = extractAdminHeader(req);
  if (!provided || !safeCompareString(provided, ADMIN_PASSWORD)) {
    res.status(401).json({ message: "Invalid password for edit mode." });
    return;
  }

  next();
}
