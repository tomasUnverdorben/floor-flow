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
const CANCELLATIONS_FILE = path.join(DATA_DIR, "cancellations.json");
const CLIENT_BUILD_DIR = path.join(__dirname, "..", "client", "dist");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ? String(process.env.ADMIN_PASSWORD) : "";
const MAX_RECURRENCE_OCCURRENCES = 52;
const PREVIEW_LOOKAHEAD_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
    { file: BOOKINGS_FILE, fallback: "[]" },
    { file: CANCELLATIONS_FILE, fallback: "[]" }
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

async function appendCancellation(entries) {
  const cancellations = await readJson(CANCELLATIONS_FILE, []);
  const payload = Array.isArray(entries) ? entries : [entries];
  cancellations.push(
    ...payload.map((entry) => ({
      ...entry,
      cancelledAt: entry.cancelledAt ?? new Date().toISOString()
    }))
  );
  await writeJson(CANCELLATIONS_FILE, cancellations);
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

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
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
    const { seatId, date, userName, recurrence, skipConflicts } = req.body || {};
    const trimmedName = typeof userName === "string" ? userName.trim() : "";
    const normalizedDate = normalizeDate(date);

    if (!seatId || !trimmedName || !normalizedDate) {
      return res.status(400).json({
        message: "seatId, date and userName are required and must be valid."
      });
    }

    let recurrenceConfig = null;
    try {
      recurrenceConfig = normalizeRecurrence(recurrence);
    } catch (error) {
      return res.status(400).json({
        message:
          error instanceof Error ? error.message : "Recurrence definition is not valid."
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

    const plan = computeBookingPlan({
      seatId,
      startDate: normalizedDate,
      recurrence: recurrenceConfig,
      bookings
    });

    if (plan.targetDates.length === 0) {
      return res.status(400).json({ message: "Requested booking dates could not be resolved." });
    }

    if (plan.conflicts.length > 0 && !skipConflicts) {
      return res.status(409).json({
        message: `Seat ${seatId} is already booked for ${plan.conflicts
          .map((conflict) => conflict.date)
          .join(", ")}.`,
        conflicts: plan.conflicts.map(toPublicConflict),
        preview: buildPreviewResponse(plan, recurrenceConfig)
      });
    }

    const allowedDates =
      plan.conflicts.length > 0 && skipConflicts
        ? plan.targetDates.filter(
            (date) => !plan.conflicts.some((conflict) => conflict.date === date)
          )
        : plan.targetDates;

    if (allowedDates.length === 0) {
      return res.status(409).json({
        message: `Seat ${seatId} is not available on any of the requested dates.`,
        conflicts: plan.conflicts.map(toPublicConflict),
        preview: buildPreviewResponse(plan, recurrenceConfig)
      });
    }

    const timestamp = new Date().toISOString();
    const seriesId = uuid();
    const newBookings = allowedDates.map((bookingDate) => ({
      id: uuid(),
      seriesId,
      seatId,
      date: bookingDate,
      userName: trimmedName,
      createdAt: timestamp
    }));

    bookings.push(...newBookings);
    await writeJson(BOOKINGS_FILE, bookings);

    if (skipConflicts) {
      res.status(201).json({
        message:
          plan.conflicts.length > 0
            ? `Created ${newBookings.length} bookings and skipped ${plan.conflicts.length}.`
            : `Created ${newBookings.length} bookings.`,
        seriesId,
        created: newBookings,
        skipped: plan.conflicts.map((conflict) => ({
          date: conflict.date,
          reason: "conflict",
          booking: toPublicConflict(conflict)
        })),
        conflicts: plan.conflicts.map(toPublicConflict).filter(Boolean),
        requestedCount: plan.targetDates.length,
        preview: buildPreviewResponse(plan, recurrenceConfig)
      });
      return;
    }

    if (newBookings.length === 1) {
      res.status(201).json(newBookings[0]);
    } else {
      res.status(201).json({
        seriesId,
        created: newBookings,
        recurrence: recurrenceConfig
          ? {
              frequency: recurrenceConfig.frequency,
              count: recurrenceConfig.count
            }
          : { frequency: "single", count: newBookings.length }
      });
    }
  } catch (error) {
    next(error);
  }
});

app.post("/api/bookings/preview", async (req, res, next) => {
  try {
    const { seatId, date, recurrence } = req.body || {};
    const normalizedDate = normalizeDate(date);

    if (!seatId || !normalizedDate) {
      return res.status(400).json({
        message: "seatId and date are required and must be valid."
      });
    }

    let recurrenceConfig = null;
    try {
      recurrenceConfig = normalizeRecurrence(recurrence);
    } catch (error) {
      return res.status(400).json({
        message:
          error instanceof Error ? error.message : "Recurrence definition is not valid."
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

    const plan = computeBookingPlan({
      seatId,
      startDate: normalizedDate,
      recurrence: recurrenceConfig,
      bookings
    });

    res.json(buildPreviewResponse(plan, recurrenceConfig));
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

    await appendCancellation({
      bookingId: removedBooking.id,
      seatId: removedBooking.seatId,
      date: removedBooking.date,
      userName: removedBooking.userName,
      source: "single"
    });

    res.json({ removed: removedBooking });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/bookings/series/:seriesId", async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    if (!seriesId) {
      return res.status(400).json({ message: "seriesId parameter is required." });
    }

    const bookings = await readJson(BOOKINGS_FILE, []);
    const today = new Date().toISOString().slice(0, 10);

    const [remaining, removed] = partitionBookingsBySeries(bookings, seriesId, today);

    if (removed.length === 0) {
      return res
        .status(404)
        .json({ message: `No upcoming bookings found for series ${seriesId}.` });
    }

    await writeJson(BOOKINGS_FILE, remaining);
    if (removed.length > 0) {
      await appendCancellation(
        removed.map((booking) => ({
          bookingId: booking.id,
          seatId: booking.seatId,
          date: booking.date,
          userName: booking.userName,
          source: "series"
        }))
      );
    }
    res.json({
      seriesId,
      removed: removed.map((booking) => ({
        id: booking.id,
        seatId: booking.seatId,
        date: booking.date,
        userName: booking.userName
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/analytics/summary", async (req, res, next) => {
  try {
    const fromParam = typeof req.query.from === "string" ? req.query.from : null;
    const toParam = typeof req.query.to === "string" ? req.query.to : null;

    const fromDate = fromParam ? normalizeDate(fromParam) : null;
    const toDate = toParam ? normalizeDate(toParam) : null;

    if (fromParam && !fromDate) {
      return res.status(400).json({ message: "Parameter 'from' must be a valid date." });
    }

    if (toParam && !toDate) {
      return res.status(400).json({ message: "Parameter 'to' must be a valid date." });
    }

    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).json({ message: "'from' must not be after 'to'." });
    }

    const [bookings, seats, cancellations] = await Promise.all([
      readJson(BOOKINGS_FILE, []),
      readJson(SEATS_FILE, []),
      readJson(CANCELLATIONS_FILE, [])
    ]);

    const seatMap = new Map(seats.map((seat) => [seat.id, seat]));

    const candidateDates = [];
    bookings.forEach((booking) => {
      if (typeof booking.date === "string") {
        candidateDates.push(booking.date);
      }
      if (typeof booking.createdAt === "string") {
        const createdDate = normalizeDate(booking.createdAt);
        if (createdDate) {
          candidateDates.push(createdDate);
        }
      }
    });
    cancellations.forEach((entry) => {
      if (typeof entry.date === "string") {
        candidateDates.push(entry.date);
      }
      if (typeof entry.cancelledAt === "string") {
        const cancelledDate = normalizeDate(entry.cancelledAt);
        if (cancelledDate) {
          candidateDates.push(cancelledDate);
        }
      }
    });

    const sortedCandidates = candidateDates.filter(Boolean).sort();
    const fallbackStart = sortedCandidates[0] ?? getTodayDateString();
    const fallbackEnd =
      sortedCandidates.length > 0
        ? sortedCandidates[sortedCandidates.length - 1]
        : getTodayDateString();

    const rangeStart = fromDate ?? fallbackStart;
    const rangeEnd = toDate ?? fallbackEnd;

    const daysInRange = Math.max(
      1,
      Math.floor(
        (new Date(rangeEnd).setUTCHours(0, 0, 0, 0) -
          new Date(rangeStart).setUTCHours(0, 0, 0, 0)) /
          MS_PER_DAY
      ) + 1
    );

    const activeBookings = bookings.filter((booking) => {
      const bookingDate = typeof booking.date === "string" ? booking.date : null;
      if (!bookingDate) {
        return false;
      }
      if (bookingDate < rangeStart) {
        return false;
      }
      if (bookingDate > rangeEnd) {
        return false;
      }
      return true;
    });

    const createdInRange = bookings.filter((booking) => {
      const creationDate =
        typeof booking.createdAt === "string" ? normalizeDate(booking.createdAt) : null;
      if (!creationDate) {
        return false;
      }
      if (creationDate < rangeStart) {
        return false;
      }
      if (creationDate > rangeEnd) {
        return false;
      }
      return true;
    });

    const cancellationsInRange = cancellations.filter((entry) => {
      const cancelledDate =
        typeof entry.cancelledAt === "string" ? normalizeDate(entry.cancelledAt) : null;
      if (!cancelledDate) {
        return false;
      }
      if (cancelledDate < rangeStart) {
        return false;
      }
      if (cancelledDate > rangeEnd) {
        return false;
      }
      return true;
    });

    const uniqueUsers = new Set(
      activeBookings
        .map((booking) => booking.userName)
        .filter((name) => typeof name === "string" && name.trim().length > 0)
    );

    const accumulateCounts = (items, keySelector) => {
      const counts = new Map();
      items.forEach((item) => {
        const key = keySelector(item);
        if (!key) {
          return;
        }
        counts.set(key, (counts.get(key) ?? 0) + 1);
      });
      return counts;
    };

    const seatCounts = accumulateCounts(activeBookings, (booking) => booking.seatId);
    const topSeats = Array.from(seatCounts.entries())
      .map(([seatId, count]) => ({
        seatId,
        label: seatMap.get(seatId)?.label ?? seatId,
        count
      }))
      .sort((a, b) => b.count - a.count || a.seatId.localeCompare(b.seatId))
      .slice(0, 5);

    const userCounts = accumulateCounts(activeBookings, (booking) => booking.userName);
    const topUsers = Array.from(userCounts.entries())
      .map(([userName, count]) => ({ userName, count }))
      .sort((a, b) => b.count - a.count || a.userName.localeCompare(b.userName))
      .slice(0, 5);

    const cancellationCounts = accumulateCounts(
      cancellationsInRange,
      (entry) => entry.userName
    );
    const topCancellations = Array.from(cancellationCounts.entries())
      .map(([userName, count]) => ({ userName, count }))
      .sort((a, b) => b.count - a.count || a.userName.localeCompare(b.userName))
      .slice(0, 5);

    const dayCounts = accumulateCounts(activeBookings, (booking) => booking.date);
    const busiestDays = Array.from(dayCounts.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => b.count - a.count || a.date.localeCompare(b.date))
      .slice(0, 7);

    const summary = {
      range: {
        from: rangeStart,
        to: rangeEnd,
        days: daysInRange
      },
      totals: {
        created: createdInRange.length,
        canceled: cancellationsInRange.length,
        active: activeBookings.length,
        uniqueUsers: uniqueUsers.size
      },
      topSeats,
      topUsers,
      topCancellations,
      busiestDays,
      averageDailyBookings: activeBookings.length / daysInRange
    };

    res.json(summary);
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
function computeBookingPlan({ seatId, startDate, recurrence, bookings }) {
  const seatBookings = bookings.filter((booking) => booking.seatId === seatId);
  const bookingMap = new Map(
    seatBookings.map((booking) => [booking.date, booking])
  );
  const targetDates = recurrence
    ? generateRecurrenceDates(startDate, recurrence)
    : [startDate];

  const conflicts = targetDates
    .map((date) => {
      const existing = bookingMap.get(date);
      if (!existing) {
        return null;
      }
      return { date, booking: existing };
    })
    .filter(Boolean);

  const availableDates = targetDates.filter((date) => !bookingMap.has(date));

  return {
    seatId,
    startDate,
    recurrence,
    targetDates,
    conflicts,
    availableDates,
    bookingMap
  };
}

function toPublicConflict(conflict) {
  if (!conflict) {
    return null;
  }

  const booking = conflict.booking ?? conflict;
  return {
    date: conflict.date ?? booking.date,
    seatId: booking.seatId,
    bookingId: booking.id,
    userName: booking.userName,
    seriesId: booking.seriesId ?? null
  };
}

function buildPreviewResponse(plan, recurrence) {
  const suggestions = computeSuggestions(plan, recurrence);
  return {
    seatId: plan.seatId,
    startDate: plan.startDate,
    requestedCount: plan.targetDates.length,
    requestedDates: plan.targetDates,
    recurrence: recurrence
      ? { frequency: recurrence.frequency, count: recurrence.count }
      : { frequency: "single", count: plan.targetDates.length },
    available: plan.availableDates,
    conflicts: plan.conflicts.map(toPublicConflict).filter(Boolean),
    suggestions
  };
}

function computeSuggestions(plan, recurrence) {
  const suggestions = {};
  const availableSet = new Set(plan.availableDates);
  const intervalDays = getIntervalDays(recurrence);

  if (plan.targetDates.length > 0) {
    const shortenDates = collectRun(plan.targetDates, 0, availableSet, intervalDays);
    suggestions.shorten = {
      count: shortenDates.length,
      dates: shortenDates
    };

    const contiguous = findLongestRun(plan.targetDates, availableSet, intervalDays);
    if (contiguous) {
      suggestions.contiguousBlock = contiguous;
    }
  }

  const alternative =
    findNextAvailableSeries(plan, recurrence, plan.bookingMap) ?? null;
  if (alternative && (plan.conflicts.length > 0 || alternative.startDate !== plan.startDate)) {
    suggestions.adjustStart = alternative;
  }

  return suggestions;
}

function getIntervalDays(recurrence) {
  if (!recurrence) {
    return null;
  }
  return recurrence.frequency === "weekly" ? 7 : 1;
}

function collectRun(targetDates, startIndex, availableSet, intervalDays) {
  if (startIndex >= targetDates.length) {
    return [];
  }

  const dates = [];
  let previous = null;

  for (let index = startIndex; index < targetDates.length; index += 1) {
    const currentDate = targetDates[index];
    if (!availableSet.has(currentDate)) {
      break;
    }

    if (dates.length > 0 && intervalDays !== null) {
      const expected = offsetDate(previous, intervalDays);
      if (expected !== currentDate) {
        break;
      }
    }

    dates.push(currentDate);
    previous = currentDate;
  }

  return dates;
}

function findLongestRun(targetDates, availableSet, intervalDays) {
  let best = { count: 0, dates: [] };

  for (let index = 0; index < targetDates.length; index += 1) {
    const currentDate = targetDates[index];
    if (!availableSet.has(currentDate)) {
      continue;
    }

    const run = collectRun(targetDates, index, availableSet, intervalDays);
    if (run.length > best.count) {
      best = {
        count: run.length,
        dates: run
      };
    }
  }

  if (best.count === 0) {
    return null;
  }

  return {
    startDate: best.dates[0],
    count: best.count,
    dates: best.dates
  };
}

function findNextAvailableSeries(plan, recurrence, bookingMap) {
  const totalOccurrences = plan.targetDates.length;
  if (totalOccurrences === 0) {
    return null;
  }

  const startDate = plan.startDate;
  const endLimit = offsetDate(startDate, PREVIEW_LOOKAHEAD_DAYS);

  for (let offset = 0; offset <= PREVIEW_LOOKAHEAD_DAYS; offset += 1) {
    const candidateStart = offsetDate(startDate, offset);
    if (candidateStart > endLimit) {
      break;
    }

    const candidateDates = recurrence
      ? generateRecurrenceDates(candidateStart, recurrence)
      : [candidateStart];

    const hasConflict = candidateDates.some((date) => bookingMap.has(date));
    if (!hasConflict) {
      return {
        startDate: candidateStart,
        dates: candidateDates
      };
    }
  }

  return null;
}

function partitionBookingsBySeries(bookings, seriesId, fromDate) {
  const keep = [];
  const removed = [];

  bookings.forEach((booking) => {
    if (
      booking.seriesId === seriesId &&
      typeof booking.date === "string" &&
      booking.date >= fromDate
    ) {
      removed.push(booking);
    } else {
      keep.push(booking);
    }
  });

  return [keep, removed];
}
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

function normalizeRecurrence(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const { frequency, count } = candidate;
  if (frequency !== "daily" && frequency !== "weekly") {
    throw new Error('Recurrence frequency must be either "daily" or "weekly".');
  }

  const parsedCount = Number(count);
  if (!Number.isFinite(parsedCount)) {
    throw new Error("Recurrence count must be a number.");
  }

  const normalizedCount = Math.trunc(parsedCount);
  if (normalizedCount < 1) {
    throw new Error("Recurrence count must be at least 1.");
  }
  if (normalizedCount > MAX_RECURRENCE_OCCURRENCES) {
    throw new Error(
      `Recurrence count must not exceed ${MAX_RECURRENCE_OCCURRENCES}.`
    );
  }

  if (normalizedCount === 1) {
    return null;
  }

  return {
    frequency,
    count: normalizedCount
  };
}

function generateRecurrenceDates(startDate, recurrence) {
  if (!recurrence) {
    return [startDate];
  }

  const intervalDays = recurrence.frequency === "daily" ? 1 : 7;
  const dates = [];

  for (let index = 0; index < recurrence.count; index += 1) {
    const offsetDays = index * intervalDays;
    dates.push(offsetDate(startDate, offsetDays));
  }

  return dates;
}

function offsetDate(startDate, offsetDays) {
  const reference = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(reference.getTime())) {
    throw new Error(`Cannot offset invalid date: ${startDate}`);
  }
  reference.setUTCDate(reference.getUTCDate() + offsetDays);
  return reference.toISOString().slice(0, 10);
}
