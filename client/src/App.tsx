import type { CSSProperties, ChangeEvent, FormEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import "./App.css";
import PrivateRoute from "./components/PrivateRoute";
import LoginRedirectPage from "./components/LoginRedirectPage.tsx";

type Seat = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  floor: number;
  zone?: string;
  notes?: string;
};

type Booking = {
  id: string;
  seatId: string;
  date: string;
  userName: string;
  createdAt: string;
  seriesId?: string;
};

type SeatDraft = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  floor: number;
  zone?: string;
  notes?: string;
};

type SeatStyle = CSSProperties & { "--seat-scale"?: string; "--seat-rotation"?: string };

type StatusBanner =
  | { type: "success" | "info"; message: string }
  | { type: "error"; message: string }
  | null;

type FloorplanInfoResponse = {
  floor: number;
  hasCustomImage: boolean;
  imageUrl: string;
  updatedAt: string | null;
  mimeType?: string | null;
  originalName?: string | null;
  size?: number | null;
};

type BuildingFloor = {
  index: number;
  name: string;
  hasFloorplan: boolean;
  updatedAt: string | null;
  imageUrl: string;
};

type BuildingInfo = {
  floorCount: number;
  floors: BuildingFloor[];
};

type RecurrenceFrequency = "none" | "daily" | "weekday" | "weekly";

type BookingConflict = {
  date: string;
  seatId: string;
  bookingId: string;
  userName: string;
  seriesId?: string | null;
};

type BookingPreview = {
  seatId: string;
  startDate: string;
  requestedCount: number;
  requestedDates: string[];
  recurrence: { frequency: "single" | "daily" | "weekday" | "weekly"; count: number };
  available: string[];
  conflicts: BookingConflict[];
  suggestions: {
    shorten?: { count: number; dates: string[] };
    contiguousBlock?: { count: number; dates: string[]; startDate: string };
    adjustStart?: { startDate: string; dates: string[] };
  };
};

type AnalyticsSummary = {
  range: { from: string | null; to: string | null; days: number };
  totals: {
    created: number;
    canceled: number;
    active: number;
    uniqueUsers: number;
  };
  topSeats: Array<{ seatId: string; label: string; count: number }>;
  topUsers: Array<{ userName: string; count: number }>;
  topCancellations: Array<{ userName: string; count: number }>;
  busiestDays: Array<{ date: string; count: number }>;
  averageDailyBookings: number;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
const ADMIN_UNAUTHORIZED_ERROR = "ADMIN_UNAUTHORIZED";
const MAX_RECURRENCE_OCCURRENCES = 52;

const formatDateForDisplay = (value: string) => {
  try {
    const asDate = new Date(value);
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long"
    }).format(asDate);
  } catch {
    return value;
  }
};

const getToday = () => new Date().toISOString().slice(0, 10);

const getDateNDaysAgo = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
};

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const normalizeCoordinate = (value: number) => Math.round(clamp(value, 0, 100) * 10) / 10;
const clampPercentage = (value: number) => Math.min(100, Math.max(0, value));
const roundToTwoDecimals = (value: number) => Math.round(value * 100) / 100;

const MIN_BAR_PERCENTAGE = 6;
const calculateBarWidth = (value: number, max: number) => {
  if (max <= 0 || value <= 0) {
    return 0;
  }
  const percentage = (value / max) * 100;
  return clamp(percentage, MIN_BAR_PERCENTAGE, 100);
};

type SeatResizeHandle = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

const RESIZE_HANDLE_CONFIG: Record<
  SeatResizeHandle,
  { moving: { x: number; y: number }; fixed: { x: number; y: number }; cursor: string }
> = {
  topLeft: { moving: { x: -1, y: -1 }, fixed: { x: 1, y: 1 }, cursor: "nwse-resize" },
  topRight: { moving: { x: 1, y: -1 }, fixed: { x: -1, y: 1 }, cursor: "nesw-resize" },
  bottomLeft: { moving: { x: -1, y: 1 }, fixed: { x: 1, y: -1 }, cursor: "nesw-resize" },
  bottomRight: { moving: { x: 1, y: 1 }, fixed: { x: -1, y: -1 }, cursor: "nwse-resize" }
};

const MIN_SEAT_SIZE = 1;
const SEAT_RESIZE_HANDLES: SeatResizeHandle[] = [
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight"
];

type SeatLike = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

type ResizeState =
  | {
      target: "seat";
      seatId: string;
      handle: SeatResizeHandle;
      original: Seat;
      fixedLocal: { x: number; y: number };
      cos: number;
      sin: number;
      hasChanges: boolean;
    }
  | {
      target: "draft";
      handle: SeatResizeHandle;
      original: SeatDraft;
      fixedLocal: { x: number; y: number };
      cos: number;
      sin: number;
      hasChanges: boolean;
    };

const resolveApiPath = (path: string) => {
  if (!path) {
    return path;
  }
  if (!API_BASE_URL) {
    return path.startsWith("/") ? path : `/${path}`;
  }
  const base = API_BASE_URL.endsWith("/") ? API_BASE_URL.slice(0, -1) : API_BASE_URL;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
};

const toLocalCoordinates = (
  seat: SeatLike,
  point: { x: number; y: number },
  cos: number,
  sin: number
) => {
  const vx = point.x - seat.x;
  const vy = point.y - seat.y;
  return {
    x: cos * vx + sin * vy,
    y: -sin * vx + cos * vy
  };
};

const fromLocalCoordinates = (
  seat: SeatLike,
  local: { x: number; y: number },
  cos: number,
  sin: number
) => ({
  x: seat.x + cos * local.x - sin * local.y,
  y: seat.y + sin * local.x + cos * local.y
});

const isBookingRecord = (candidate: unknown): candidate is Booking => {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const value = candidate as Record<string, unknown>;
  return (
    typeof value.id === "string" &&
    typeof value.seatId === "string" &&
    typeof value.date === "string" &&
    typeof value.userName === "string" &&
    typeof value.createdAt === "string" &&
    (typeof value.seriesId === "string" ||
      typeof value.seriesId === "undefined" ||
      value.seriesId === null)
  );
};

const extractCreatedBookings = (payload: unknown): Booking[] => {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload.filter(isBookingRecord);
  }

  if (typeof payload === "object") {
    const objectPayload = payload as Record<string, unknown>;
    if (Array.isArray(objectPayload.created)) {
      return objectPayload.created.filter(isBookingRecord);
    }
    if (isBookingRecord(payload)) {
      return [payload];
    }
  }

  return [];
};

const isConflictRecord = (candidate: unknown): candidate is BookingConflict => {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const value = candidate as Record<string, unknown>;
  return (
    typeof value.date === "string" &&
    typeof value.seatId === "string" &&
    typeof value.bookingId === "string" &&
    typeof value.userName === "string"
  );
};

const extractConflicts = (payload: unknown): BookingConflict[] => {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const value = payload as Record<string, unknown>;
  if (Array.isArray(value.conflicts)) {
    return value.conflicts.filter(isConflictRecord);
  }

  return [];
};

const toStringArray = (input: unknown): string[] =>
  Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];

const extractPreview = (payload: unknown): BookingPreview | null => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const value = payload as Record<string, unknown>;
  if (
    typeof value.seatId !== "string" ||
    typeof value.startDate !== "string" ||
    typeof value.requestedCount !== "number"
  ) {
    return null;
  }

  const recurrenceRaw = value.recurrence;
  if (
    !recurrenceRaw ||
    typeof recurrenceRaw !== "object" ||
    typeof (recurrenceRaw as Record<string, unknown>).frequency !== "string" ||
    typeof (recurrenceRaw as Record<string, unknown>).count !== "number"
  ) {
    return null;
  }

  const suggestionsRaw = value.suggestions;
  const suggestions: BookingPreview["suggestions"] = {};
  if (suggestionsRaw && typeof suggestionsRaw === "object") {
    const suggestionsValue = suggestionsRaw as Record<string, unknown>;
    const shortenRaw = suggestionsValue.shorten;
    if (
      shortenRaw &&
      typeof shortenRaw === "object" &&
      typeof (shortenRaw as Record<string, unknown>).count === "number"
    ) {
      suggestions.shorten = {
        count: (shortenRaw as Record<string, unknown>).count as number,
        dates: toStringArray((shortenRaw as Record<string, unknown>).dates)
      };
    }

    const contiguousRaw = suggestionsValue.contiguousBlock;
    if (
      contiguousRaw &&
      typeof contiguousRaw === "object" &&
      typeof (contiguousRaw as Record<string, unknown>).count === "number" &&
      typeof (contiguousRaw as Record<string, unknown>).startDate === "string"
    ) {
      suggestions.contiguousBlock = {
        count: (contiguousRaw as Record<string, unknown>).count as number,
        startDate: (contiguousRaw as Record<string, unknown>).startDate as string,
        dates: toStringArray((contiguousRaw as Record<string, unknown>).dates)
      };
    }

    const adjustRaw = suggestionsValue.adjustStart;
    if (
      adjustRaw &&
      typeof adjustRaw === "object" &&
      typeof (adjustRaw as Record<string, unknown>).startDate === "string"
    ) {
      suggestions.adjustStart = {
        startDate: (adjustRaw as Record<string, unknown>).startDate as string,
        dates: toStringArray((adjustRaw as Record<string, unknown>).dates)
      };
    }
  }

  if (!suggestions.shorten) {
    suggestions.shorten = { count: 0, dates: [] };
  }

  return {
    seatId: value.seatId as string,
    startDate: value.startDate as string,
    requestedCount: value.requestedCount as number,
    requestedDates: toStringArray(value.requestedDates),
    recurrence: {
      frequency: (recurrenceRaw as Record<string, unknown>).frequency as
        | "single"
        | "daily"
        | "weekly",
      count: (recurrenceRaw as Record<string, unknown>).count as number
    },
    available: toStringArray(value.available),
    conflicts: extractConflicts(value),
    suggestions
  };
};

function MainDashboard() {
  const navigate = useNavigate();
  const [seats, setSeats] = useState<Seat[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [allBookings, setAllBookings] = useState<Booking[]>([]);
  const [isLoadingAllBookings, setIsLoadingAllBookings] = useState(true);
  const [selectedUserName, setSelectedUserName] = useState<string | null>(null);
  const [bookingActionInFlight, setBookingActionInFlight] = useState<{
    bookingId: string;
    type: "cancel" | "move";
  } | null>(null);
  const [bookingBeingRescheduledId, setBookingBeingRescheduledId] = useState<string | null>(null);
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({});
  const [selectedSeatId, setSelectedSeatId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>(getToday());
  const [nameInput, setNameInput] = useState<string>("");
  const [isLoadingSeats, setIsLoadingSeats] = useState(true);
  const [isLoadingBookings, setIsLoadingBookings] = useState(true);
  const [statusBanner, setStatusBanner] = useState<StatusBanner>(null);
  const [isEditorMode, setIsEditorMode] = useState(false);
  const [draftSeat, setDraftSeat] = useState<SeatDraft | null>(null);
  const [draggingSeatId, setDraggingSeatId] = useState<string | null>(null);
  const [seatEditorDraft, setSeatEditorDraft] = useState<SeatDraft | null>(null);
  const [mapZoom, setMapZoom] = useState(1);
  const [seatScale, setSeatScale] = useState(1);
  const [floorplanSize, setFloorplanSize] = useState<{ width: number; height: number } | null>(
    null
  );
  const [buildingInfo, setBuildingInfo] = useState<BuildingInfo | null>(null);
  const [selectedFloor, setSelectedFloor] = useState<number>(1);
  const [floorplans, setFloorplans] = useState<Record<number, FloorplanInfoResponse>>({});
  const [floorCountInput, setFloorCountInput] = useState<string>("1");
  const [isDrawingSeat, setIsDrawingSeat] = useState(false);
  const drawingStartRef = useRef<{ x: number; y: number } | null>(null);
  const [draftDrawingRect, setDraftDrawingRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [activeResizeTarget, setActiveResizeTarget] = useState<string | "draft" | null>(null);
  const resizingStateRef = useRef<ResizeState | null>(null);
  const [isFloorplanUploading, setIsFloorplanUploading] = useState(false);
  const [isFloorplanDeleting, setIsFloorplanDeleting] = useState(false);
  const [adminSecret, setAdminSecret] = useState<string | null>(null);
  const [isEditorAuthorized, setIsEditorAuthorized] = useState(false);
  const [repeatFrequency, setRepeatFrequency] = useState<RecurrenceFrequency>("none");
  const [repeatCount, setRepeatCount] = useState<number>(1);
  const [repeatCountInput, setRepeatCountInput] = useState<string>("1");
  const [bookingPreview, setBookingPreview] = useState<BookingPreview | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isBookingSubmitting, setIsBookingSubmitting] = useState(false);
  const [conflictContext, setConflictContext] = useState<{
    conflicts: BookingConflict[];
    preview: BookingPreview | null;
  } | null>(null);
  const floorplanRef = useRef<HTMLDivElement | null>(null);
  const floorplanContentRef = useRef<HTMLDivElement | null>(null);
  const floorplanFileInputRef = useRef<HTMLInputElement | null>(null);
  const dragOriginalSeatRef = useRef<Seat | null>(null);
  const dragLatestPositionRef = useRef<{ x: number; y: number } | null>(null);
  const seatsRef = useRef<Seat[]>([]);
  const previousZoomRef = useRef(mapZoom);

  useEffect(() => {
    seatsRef.current = seats;
  }, [seats]);

  const currentFloorplanInfo = floorplans[selectedFloor];
  const floorplanImageUrl = resolveApiPath(
    currentFloorplanInfo?.imageUrl ?? `/api/floorplans/${selectedFloor}/image`
  );
  const hasCustomFloorplan = Boolean(currentFloorplanInfo?.hasCustomImage);
  const availableFloors = buildingInfo?.floors ?? [
    {
      index: 1,
      name: "Floor 1",
      hasFloorplan: hasCustomFloorplan,
      updatedAt: currentFloorplanInfo?.updatedAt ?? null,
      imageUrl: floorplanImageUrl
    }
  ];
  const currentFloorName =
    availableFloors.find((floor) => floor.index === selectedFloor)?.name ??
    `Floor ${selectedFloor}`;
  const getFloorName = (index: number) =>
    availableFloors.find((floor) => floor.index === index)?.name ?? `Floor ${index}`;

  const updateSeatOnServer = useCallback(
    async (seatId: string, updates: Partial<SeatDraft>) => {
      const payload: Record<string, unknown> = { ...updates };
      if (typeof updates.x === "number") {
        payload.x = normalizeCoordinate(updates.x);
      }
      if (typeof updates.y === "number") {
        payload.y = normalizeCoordinate(updates.y);
      }
      if (typeof updates.floor === "number") {
        payload.floor = Math.max(1, Math.trunc(updates.floor));
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (adminSecret) {
        headers["x-admin-secret"] = adminSecret;
      }

      const response = await fetch(`${API_BASE_URL}/api/seats/${encodeURIComponent(seatId)}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("ADMIN_UNAUTHORIZED");
        }
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          payload?.message ?? `Updating the seat failed (status ${response.status}).`
        );
      }

      const existingSeat = seatsRef.current.find((item) => item.id === seatId);
      const updatedSeat: Seat = await response.json();
      const normalizedSeat: Seat = {
        ...updatedSeat,
        x: normalizeCoordinate(updatedSeat.x),
        y: normalizeCoordinate(updatedSeat.y),
        width: Math.max(
          0.5,
          Math.min(
            100,
            Number(
              updatedSeat.width ??
                (typeof updates.width === "number" ? updates.width : undefined) ??
                existingSeat?.width ??
                6
            )
          )
        ),
        height: Math.max(
          0.5,
          Math.min(
            100,
            Number(
              updatedSeat.height ??
                (typeof updates.height === "number" ? updates.height : undefined) ??
                existingSeat?.height ??
                6
            )
          )
        ),
        rotation: Number.isFinite(updatedSeat.rotation)
          ? Math.trunc(updatedSeat.rotation)
          : typeof updates.rotation === "number"
          ? Math.trunc(updates.rotation)
          : existingSeat?.rotation ?? 0,
        floor: Math.max(
          1,
          Math.trunc(
            updatedSeat.floor ??
              (typeof updates.floor === "number" ? updates.floor : undefined) ??
              existingSeat?.floor ??
              1
          )
        )
      };
      setSeats((existing) =>
        existing.map((seat) => (seat.id === normalizedSeat.id ? normalizedSeat : seat))
      );
      setSeatEditorDraft((current) => {
        if (!current || current.id !== normalizedSeat.id) {
          return current;
        }
        return {
          id: normalizedSeat.id,
          label: normalizedSeat.label,
          x: normalizedSeat.x,
          y: normalizedSeat.y,
          width: normalizedSeat.width,
          height: normalizedSeat.height,
          rotation: normalizedSeat.rotation,
          floor: normalizedSeat.floor,
          zone: normalizedSeat.zone ?? "",
          notes: normalizedSeat.notes ?? ""
        };
      });
      return normalizedSeat;
    },
    [adminSecret]
  );

  const createSeatOnServer = useCallback(
    async (seat: SeatDraft) => {
      const payload: SeatDraft = {
        ...seat,
        x: normalizeCoordinate(seat.x),
        y: normalizeCoordinate(seat.y),
        width: Math.max(0.5, Math.min(100, Number(seat.width ?? 6))),
        height: Math.max(0.5, Math.min(100, Number(seat.height ?? 6))),
        rotation: Number.isFinite(seat.rotation) ? Math.trunc(seat.rotation) : 0,
        floor: Math.max(1, Math.trunc(seat.floor ?? 1))
      };

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (adminSecret) {
        headers["x-admin-secret"] = adminSecret;
      }

      const response = await fetch(`${API_BASE_URL}/api/seats`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("ADMIN_UNAUTHORIZED");
        }
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          payload?.message ?? `Creating the seat failed (status ${response.status}).`
        );
      }

      const createdSeat: Seat = await response.json();
      const normalizedSeat: Seat = {
        ...createdSeat,
        x: normalizeCoordinate(createdSeat.x),
        y: normalizeCoordinate(createdSeat.y),
        width: Math.max(0.5, Math.min(100, Number(createdSeat.width ?? payload.width ?? 6))),
        height: Math.max(0.5, Math.min(100, Number(createdSeat.height ?? payload.height ?? 6))),
        rotation: Number.isFinite(createdSeat.rotation)
          ? Math.trunc(createdSeat.rotation)
          : payload.rotation ?? 0,
        floor: Math.max(1, Math.trunc(createdSeat.floor ?? payload.floor ?? 1))
      };
      setSeats((existing) => [...existing, normalizedSeat]);
      return normalizedSeat;
    },
    [adminSecret]
  );

  const deleteSeatOnServer = useCallback(
    async (seatId: string) => {
      const headers: Record<string, string> = {};
      if (adminSecret) {
        headers["x-admin-secret"] = adminSecret;
      }

      const response = await fetch(`${API_BASE_URL}/api/seats/${encodeURIComponent(seatId)}`, {
        method: "DELETE",
        headers
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("ADMIN_UNAUTHORIZED");
        }
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          payload?.message ?? `Deleting the seat failed (status ${response.status}).`
        );
      }

      setSeats((existing) => existing.filter((seat) => seat.id !== seatId));
    },
    [adminSecret]
  );

  const handleAdminUnauthorized = useCallback(() => {
    setAdminSecret(null);
    setIsEditorAuthorized(false);
    setIsEditorMode(false);
    setStatusBanner({
      type: "error",
      message: "The password is invalid or expired. Turn edit mode on again."
    });
    setIsDrawingSeat(false);
    setDraftDrawingRect(null);
  }, []);

  const verifyAdminSecret = useCallback(
    async (secret: string) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (secret) {
        headers["x-admin-secret"] = secret;
      }

      const response = await fetch(`${API_BASE_URL}/api/admin/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({ password: secret })
      });

      const payload = (await response.json().catch(() => ({}))) as {
        authorized?: boolean;
        passwordRequired?: boolean;
        message?: string;
      };

      if (!response.ok) {
        throw new Error(payload?.message ?? "The password is not valid.");
      }

      return payload;
    },
    []
  );

  const fetchFloorplanInfo = useCallback(async (floor: number) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/floorplans/${floor}`);
      if (!response.ok) {
        throw new Error(`Failed to load floor plan (status ${response.status})`);
      }
      const payload: FloorplanInfoResponse = await response.json();
      const resolvedUrl = resolveApiPath(payload.imageUrl);
      setFloorplans((current) => ({
        ...current,
        [floor]: {
          ...payload,
          imageUrl: resolvedUrl
        }
      }));
      setBuildingInfo((current) =>
        current
          ? {
              ...current,
              floors: current.floors.map((floorInfo) =>
                floorInfo.index === payload.floor
                  ? {
                      ...floorInfo,
                      hasFloorplan: Boolean(payload.hasCustomImage),
                      updatedAt: payload.updatedAt,
                      imageUrl: resolvedUrl
                    }
                  : floorInfo
              )
            }
          : current
      );
    } catch (error) {
      console.error(error);
      setStatusBanner({
        type: "error",
        message: "Failed to load the floor plan image. Please refresh the page."
      });
    }
  }, [setStatusBanner]);

  const fetchBuildingInfo = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/building`);
      if (!response.ok) {
        throw new Error(`Failed to load building configuration (status ${response.status})`);
      }
      const payload = (await response.json()) as BuildingInfo;
      setBuildingInfo(payload);
      setFloorCountInput(String(payload.floorCount));
      const nextFloorplans: Record<number, FloorplanInfoResponse> = {};
      payload.floors.forEach((floor) => {
        nextFloorplans[floor.index] = {
          floor: floor.index,
          hasCustomImage: floor.hasFloorplan,
          imageUrl: resolveApiPath(floor.imageUrl),
          updatedAt: floor.updatedAt
        };
      });
      setFloorplans(nextFloorplans);
      setSelectedFloor((current) => {
        if (payload.floors.some((floor) => floor.index === current)) {
          return current;
        }
        return payload.floors[0]?.index ?? 1;
      });
    } catch (error) {
      console.error(error);
      setStatusBanner({
        type: "error",
        message: "Failed to load building details. Please refresh the page."
      });
    }
  }, [setStatusBanner]);

  const fetchSeats = useCallback(async () => {
    setIsLoadingSeats(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/seats`);
      if (!response.ok) {
        throw new Error(`Failed to load seats (status ${response.status})`);
      }
      const seatPayload: Seat[] = await response.json();
      const normalizedSeats = seatPayload.map((seat) => ({
        ...seat,
        x: normalizeCoordinate(seat.x),
        y: normalizeCoordinate(seat.y),
        width: Math.max(0.5, Math.min(100, Number(seat.width ?? 6))),
        height: Math.max(0.5, Math.min(100, Number(seat.height ?? 6))),
        rotation: Number.isFinite(seat.rotation) ? Math.trunc(seat.rotation) : 0,
        floor: Math.max(1, Math.trunc(seat.floor ?? 1))
      }));
      setSeats(normalizedSeats);
    } catch (error) {
      console.error(error);
      setStatusBanner({
        type: "error",
        message: "Failed to load the seat list. Please try again."
      });
    } finally {
      setIsLoadingSeats(false);
    }
  }, []);

  const fetchAllBookings = useCallback(async () => {
    setIsLoadingAllBookings(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/bookings`);
      if (!response.ok) {
        throw new Error(`Failed to load bookings (status ${response.status})`);
      }
      const bookingPayload: Booking[] = await response.json();
      setAllBookings(bookingPayload);
    } catch (error) {
      console.error(error);
      setStatusBanner({
        type: "error",
        message: "Failed to load the full booking list. Please try again."
      });
    } finally {
      setIsLoadingAllBookings(false);
    }
  }, []);

  useEffect(() => {
    fetchSeats();
  }, [fetchSeats]);

  useEffect(() => {
    fetchAllBookings();
  }, [fetchAllBookings]);

  useEffect(() => {
    fetchBuildingInfo();
  }, [fetchBuildingInfo]);

  useEffect(() => {
    if (buildingInfo && !floorplans[selectedFloor]) {
      fetchFloorplanInfo(selectedFloor);
    }
  }, [buildingInfo, selectedFloor, floorplans, fetchFloorplanInfo]);

  useEffect(() => {
    if (!selectedSeatId) {
      return;
    }
    const seat = seats.find((entry) => entry.id === selectedSeatId);
    if (!seat || seat.floor !== selectedFloor) {
      setSelectedSeatId(null);
      setSeatEditorDraft(null);
    }
  }, [selectedFloor, seats, selectedSeatId]);

  useEffect(() => {
    setDraftSeat((current) => (current ? { ...current, floor: selectedFloor } : current));
  }, [selectedFloor]);

  useEffect(() => {
    setFloorplanSize(null);
  }, [floorplanImageUrl]);

  useEffect(() => {
    const loadBookings = async (date: string) => {
      setIsLoadingBookings(true);
      try {
        const query = new URLSearchParams({ date }).toString();
        const response = await fetch(`${API_BASE_URL}/api/bookings?${query}`);
        if (!response.ok) {
          throw new Error(`Failed to load bookings (status ${response.status})`);
        }
        const bookingPayload: Booking[] = await response.json();
        setBookings(bookingPayload);
        setAllBookings((existing) => {
          const filtered = existing.filter((booking) => booking.date !== date);
          return [...filtered, ...bookingPayload];
        });
      } catch (error) {
        console.error(error);
        setStatusBanner({
          type: "error",
          message: "Failed to load bookings for the selected day."
        });
      } finally {
        setIsLoadingBookings(false);
      }
    };

    loadBookings(selectedDate);
  }, [selectedDate]);

  useEffect(() => {
    if (!selectedSeatId) {
      setNameInput("");
      return;
    }

    const booking = bookings.find((entry) => entry.seatId === selectedSeatId);
    setNameInput(booking ? booking.userName : "");
  }, [bookings, selectedSeatId]);

  const seatsOnFloor = useMemo(
    () => seats.filter((seat) => seat.floor === selectedFloor),
    [seats, selectedFloor]
  );

  const selectedSeat = useMemo(
    () =>
      selectedSeatId
        ? seats.find((seat) => seat.id === selectedSeatId && seat.floor === selectedFloor) ?? null
        : null,
    [seats, selectedSeatId, selectedFloor]
  );

  const selectedSeatBooking = useMemo(
    () =>
      selectedSeatId ? bookings.find((booking) => booking.seatId === selectedSeatId) ?? null : null,
    [bookings, selectedSeatId]
  );

  useEffect(() => {
    if (!selectedSeatBooking) {
      setRepeatFrequency("none");
      setRepeatCount(1);
      setRepeatCountInput("1");
    }
  }, [selectedSeatBooking]);

  useEffect(() => {
    setBookingPreview(null);
    setConflictContext(null);
  }, [selectedSeatId, selectedDate]);

  useEffect(() => {
    if (!isEditorMode) {
      setDraftSeat(null);
      setSeatEditorDraft(null);
      setDraggingSeatId(null);
      dragOriginalSeatRef.current = null;
      dragLatestPositionRef.current = null;
      drawingStartRef.current = null;
      setDraftDrawingRect(null);
      setIsDrawingSeat(false);
    }
  }, [isEditorMode]);

  useEffect(() => {
    if (!isEditorMode) {
      return;
    }

    if (selectedSeat) {
      setSeatEditorDraft((current) =>
        current && current.id === selectedSeat.id
          ? current
          : {
              id: selectedSeat.id,
              label: selectedSeat.label,
              x: normalizeCoordinate(selectedSeat.x),
              y: normalizeCoordinate(selectedSeat.y),
              width: Math.max(0.5, Math.min(100, Number(selectedSeat.width ?? 6))),
              height: Math.max(0.5, Math.min(100, Number(selectedSeat.height ?? 6))),
              rotation: Number.isFinite(selectedSeat.rotation)
                ? Math.trunc(selectedSeat.rotation)
                : 0,
              floor: Math.max(1, Math.trunc(selectedSeat.floor)),
              zone: selectedSeat.zone ?? "",
              notes: selectedSeat.notes ?? ""
            }
      );
    } else {
      setSeatEditorDraft(null);
    }
  }, [isEditorMode, selectedSeat]);

  useEffect(() => {
    if (!isEditorMode || !selectedSeatId) {
      return;
    }

    const latestSeat = seats.find((seat) => seat.id === selectedSeatId);
    if (!latestSeat) {
      return;
    }

    setSeatEditorDraft((current) => {
      if (!current || current.id !== selectedSeatId) {
        return current;
      }

      const normalizedX = normalizeCoordinate(latestSeat.x);
      const normalizedY = normalizeCoordinate(latestSeat.y);
      const normalizedFloor = Math.max(1, Math.trunc(latestSeat.floor));
      const normalizedWidth = Math.max(0.5, Math.min(100, Number(latestSeat.width ?? current.width ?? 6)));
      const normalizedHeight = Math.max(0.5, Math.min(100, Number(latestSeat.height ?? current.height ?? 6)));
      const normalizedRotation = Number.isFinite(latestSeat.rotation)
        ? Math.trunc(latestSeat.rotation)
        : current.rotation ?? 0;
      if (
        Math.abs(current.x - normalizedX) < 0.0001 &&
        Math.abs(current.y - normalizedY) < 0.0001 &&
        current.floor === normalizedFloor &&
        Math.abs(current.width - normalizedWidth) < 0.0001 &&
        Math.abs(current.height - normalizedHeight) < 0.0001 &&
        current.rotation === normalizedRotation
      ) {
        return current;
      }

      return {
        ...current,
        x: normalizedX,
        y: normalizedY,
        width: normalizedWidth,
        height: normalizedHeight,
        rotation: normalizedRotation,
        floor: normalizedFloor
      };
    });
  }, [isEditorMode, seats, selectedSeatId]);

  useEffect(() => {
    if (!isEditorMode || !draggingSeatId) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const rect = floorplanContentRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      event.preventDefault();

      const rawX = ((event.clientX - rect.left) / rect.width) * 100;
      const rawY = ((event.clientY - rect.top) / rect.height) * 100;
      const relativeX = normalizeCoordinate(rawX);
      const relativeY = normalizeCoordinate(rawY);

      dragLatestPositionRef.current = { x: relativeX, y: relativeY };
      setSeats((currentSeats) =>
        currentSeats.map((seat) =>
          seat.id === draggingSeatId ? { ...seat, x: relativeX, y: relativeY } : seat
        )
      );

      if (selectedSeatId === draggingSeatId) {
        setSeatEditorDraft((draft) =>
          draft ? { ...draft, x: relativeX, y: relativeY } : draft
        );
      }
    };

    const handlePointerUp = async () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);

      const latest = dragLatestPositionRef.current;
      const original = dragOriginalSeatRef.current;

      dragLatestPositionRef.current = null;
      dragOriginalSeatRef.current = null;
      setDraggingSeatId(null);

      if (!latest || !original) {
        return;
      }

      const moved =
        Math.abs(latest.x - original.x) > 0.001 || Math.abs(latest.y - original.y) > 0.001;

      if (!moved) {
        return;
      }

      try {
        await updateSeatOnServer(original.id, {
          x: latest.x,
          y: latest.y
        });
        setStatusBanner({
          type: "success",
          message: `Seat ${original.label} position saved.`
        });
      } catch (error) {
        console.error(error);
        setSeats((currentSeats) =>
          currentSeats.map((seat) => (seat.id === original.id ? original : seat))
        );
        if (error instanceof Error && error.message === ADMIN_UNAUTHORIZED_ERROR) {
          handleAdminUnauthorized();
          return;
        }
        setStatusBanner({
          type: "error",
          message:
            error instanceof Error ? error.message : "Failed to save the position."
        });
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [draggingSeatId, handleAdminUnauthorized, isEditorMode, selectedSeatId, updateSeatOnServer]);

  const anyDataLoading = isLoadingSeats || isLoadingBookings || isLoadingAllBookings;

  const sortedBookings = useMemo(
    () => [...bookings].sort((a, b) => a.seatId.localeCompare(b.seatId)),
    [bookings]
  );

  const seatById = useMemo(() => {
    const lookup = new Map<string, Seat>();
    seats.forEach((seat) => {
      lookup.set(seat.id, seat);
    });
    return lookup;
  }, [seats]);

  const { suggestedSeats, totalAvailableSeats } = useMemo(() => {
    if (seats.length === 0) {
      return { suggestedSeats: [] as Seat[], totalAvailableSeats: 0 };
    }

    const occupiedSeatIds = new Set(bookings.map((booking) => booking.seatId));
    const freeSeats = seats.filter((seat) => !occupiedSeatIds.has(seat.id));
    const sorted = freeSeats
      .slice()
      .sort((a, b) => {
        const aOnCurrentFloor = a.floor === selectedFloor ? 0 : 1;
        const bOnCurrentFloor = b.floor === selectedFloor ? 0 : 1;
        if (aOnCurrentFloor !== bOnCurrentFloor) {
          return aOnCurrentFloor - bOnCurrentFloor;
        }
        const labelA = a.label || a.id;
        const labelB = b.label || b.id;
        return labelA.localeCompare(labelB, undefined, { numeric: true, sensitivity: "base" });
      });

    return {
      suggestedSeats: sorted.slice(0, 5),
      totalAvailableSeats: freeSeats.length
    };
  }, [bookings, seats, selectedFloor]);

  const usersWithBookings = useMemo(
    () =>
      Array.from(
        allBookings.reduce((carry, booking) => {
          if (!carry.has(booking.userName)) {
            carry.set(booking.userName, []);
          }
          carry.get(booking.userName)!.push(booking);
          return carry;
        }, new Map<string, Booking[]>())
      )
        .map(([userName, userBookings]) => ({
          userName,
          bookings: [...userBookings].sort((a, b) => {
            const dateDiff = a.date.localeCompare(b.date);
            if (dateDiff !== 0) {
              return dateDiff;
            }
            return a.seatId.localeCompare(b.seatId);
          })
        }))
        .sort((a, b) => a.userName.localeCompare(b.userName, undefined, { sensitivity: "base" })),
    [allBookings]
  );

  useEffect(() => {
    setSelectedUserName((current) => {
      if (current && usersWithBookings.some((entry) => entry.userName === current)) {
        return current;
      }
      return null;
    });
  }, [usersWithBookings]);

  const selectedUserBookings = useMemo(() => {
    if (!selectedUserName) {
      return [];
    }
    const entry = usersWithBookings.find((user) => user.userName === selectedUserName);
    return entry ? entry.bookings : [];
  }, [selectedUserName, usersWithBookings]);

  const getAvailableSeatsForBooking = useCallback(
    (booking: Booking) => {
      const seatForBooking = seats.find((seat) => seat.id === booking.seatId);
      const targetFloor = seatForBooking?.floor ?? selectedFloor;
      const occupiedSeats = new Set(
        allBookings
          .filter((entry) => entry.date === booking.date && entry.id !== booking.id)
          .map((entry) => entry.seatId)
      );
      return seats.filter(
        (seat) => seat.floor === targetFloor && !occupiedSeats.has(seat.id)
      );
    },
    [allBookings, seats, selectedFloor]
  );

  const handleMoveTargetChange = useCallback((bookingId: string, seatId: string) => {
    setMoveTargets((current) => ({
      ...current,
      [bookingId]: seatId
    }));
  }, []);

  const handleStartMoveBooking = useCallback(
    (booking: Booking) => {
      if (bookingBeingRescheduledId === booking.id) {
        setBookingBeingRescheduledId(null);
        setMoveTargets((current) => {
          if (!(booking.id in current)) {
            return current;
          }
          const updated = { ...current };
          delete updated[booking.id];
          return updated;
        });
        return;
      }

      const alternatives = getAvailableSeatsForBooking(booking).filter(
        (seat) => seat.id !== booking.seatId
      );

      if (alternatives.length === 0) {
        setStatusBanner({
          type: "info",
          message: `No alternative seats are free on ${formatDateForDisplay(booking.date)}.`
        });
        return;
      }

      setBookingBeingRescheduledId(booking.id);
      setMoveTargets((current) => ({
        ...current,
        [booking.id]: alternatives[0].id
      }));
    },
    [bookingBeingRescheduledId, getAvailableSeatsForBooking, setStatusBanner]
  );

  const handleCancelUserBooking = useCallback(
    async (booking: Booking) => {
      setBookingActionInFlight({ bookingId: booking.id, type: "cancel" });
      try {
        const response = await fetch(`${API_BASE_URL}/api/bookings/${booking.id}`, {
          method: "DELETE"
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(
            payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).message === "string"
              ? ((payload as Record<string, unknown>).message as string)
              : `Canceling the booking failed (status ${response.status}).`
          );
        }

        setBookings((existing) => existing.filter((entry) => entry.id !== booking.id));
        setAllBookings((existing) => existing.filter((entry) => entry.id !== booking.id));
        setStatusBanner({
          type: "info",
          message: `Booking for ${booking.userName} on ${formatDateForDisplay(
            booking.date
          )} has been canceled.`
        });
      } catch (error) {
        console.error(error);
        setStatusBanner({
          type: "error",
          message:
            error instanceof Error ? error.message : "Failed to cancel the booking."
        });
      } finally {
        setBookingActionInFlight(null);
        if (bookingBeingRescheduledId === booking.id) {
          setBookingBeingRescheduledId(null);
          setMoveTargets((current) => {
            if (!(booking.id in current)) {
              return current;
            }
            const updated = { ...current };
            delete updated[booking.id];
            return updated;
          });
        }
      }
    },
    [bookingBeingRescheduledId, setStatusBanner]
  );

  const handleMoveBooking = useCallback(
    async (booking: Booking, targetSeatId: string) => {
      if (!targetSeatId || targetSeatId === booking.seatId) {
        setStatusBanner({
          type: "info",
          message: "Select a different seat to move the booking."
        });
        return;
      }

      setBookingActionInFlight({ bookingId: booking.id, type: "move" });

      try {
        const createResponse = await fetch(`${API_BASE_URL}/api/bookings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seatId: targetSeatId,
            date: booking.date,
            userName: booking.userName
          })
        });

        const createPayload = await createResponse.json().catch(() => ({}));

        if (!createResponse.ok) {
          throw new Error(
            createPayload && typeof createPayload === "object" && typeof (createPayload as Record<string, unknown>).message === "string"
              ? ((createPayload as Record<string, unknown>).message as string)
              : `Failed to create replacement booking (status ${createResponse.status}).`
          );
        }

        const createdBookings = extractCreatedBookings(createPayload);
        if (createdBookings.length === 0) {
          throw new Error("Booking move succeeded but the server response was unexpected.");
        }

        const replacement =
          createdBookings.find(
            (entry) => entry.date === booking.date && entry.seatId === targetSeatId
          ) ?? createdBookings[0];

        const deleteResponse = await fetch(`${API_BASE_URL}/api/bookings/${booking.id}`, {
          method: "DELETE"
        });

        if (!deleteResponse.ok) {
          const deletePayload = await deleteResponse.json().catch(() => ({}));
          if (replacement) {
            await fetch(`${API_BASE_URL}/api/bookings/${replacement.id}`, {
              method: "DELETE"
            }).catch((rollbackError) => {
              console.error("Failed to roll back replacement booking", rollbackError);
            });
          }
          throw new Error(
            deletePayload && typeof deletePayload === "object" && typeof (deletePayload as Record<string, unknown>).message === "string"
              ? ((deletePayload as Record<string, unknown>).message as string)
              : `Failed to remove the original booking (status ${deleteResponse.status}).`
          );
        }

        setAllBookings((existing) => {
          const withoutOriginal = existing.filter(
            (entry) =>
              entry.id !== booking.id &&
              !createdBookings.some((created) => created.id === entry.id)
          );
          return [...withoutOriginal, ...createdBookings];
        });

        if (booking.date === selectedDate) {
          setBookings((existing) => {
            const withoutOriginal = existing.filter(
              (entry) =>
                entry.id !== booking.id &&
                !createdBookings.some((created) => created.id === entry.id)
            );
            const replacementsForDate = createdBookings.filter(
              (entry) => entry.date === selectedDate
            );
            return [...withoutOriginal, ...replacementsForDate];
          });
        } else {
          setBookings((existing) => existing.filter((entry) => entry.id !== booking.id));
        }

        setStatusBanner({
          type: "success",
          message: `Booking moved to ${
            seatById.get(targetSeatId)?.label ?? targetSeatId
          } for ${formatDateForDisplay(booking.date)}.`
        });
      } catch (error) {
        console.error(error);
        setStatusBanner({
          type: "error",
          message: error instanceof Error ? error.message : "Failed to move the booking."
        });
      } finally {
        setBookingActionInFlight(null);
        setBookingBeingRescheduledId(null);
        setMoveTargets((current) => {
          if (!(booking.id in current)) {
            return current;
          }
          const updated = { ...current };
          delete updated[booking.id];
          return updated;
        });
      }
    },
    [seatById, selectedDate, setStatusBanner]
  );

  const floorplanContentStyle = useMemo<CSSProperties>(() => {
    if (floorplanSize) {
      return {
        width: `${floorplanSize.width * mapZoom}px`,
        height: `${floorplanSize.height * mapZoom}px`
      };
    }
    return {
      width: "100%",
      minHeight: "60vh"
    };
  }, [floorplanSize, mapZoom]);

  const getAutoFitView = useCallback(() => {
    if (!floorplanSize) {
      return null;
    }

    const containerWidth = floorplanRef.current?.clientWidth;
    if (!containerWidth || containerWidth <= 0) {
      return null;
    }

    const ratio = containerWidth / floorplanSize.width;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return null;
    }

    const normalized = Number(ratio.toFixed(2));
    const zoomValue = Math.min(2, Math.max(0.3, normalized));
    const seatScaleValue = Math.min(1.5, Math.max(0.6, normalized));

    return { zoomValue, seatScaleValue };
  }, [floorplanSize]);

  useEffect(() => {
    if (!floorplanRef.current || !floorplanSize) {
      previousZoomRef.current = mapZoom;
      return;
    }
    const container = floorplanRef.current;
    const previousZoom = previousZoomRef.current;
    if (previousZoom === mapZoom) {
      return;
    }

    const zoomRatio = mapZoom / previousZoom;
    const currentCenterX = container.scrollLeft + container.clientWidth / 2;
    const currentCenterY = container.scrollTop + container.clientHeight / 2;
    const newCenterX = currentCenterX * zoomRatio;
    const newCenterY = currentCenterY * zoomRatio;
    const targetLeft = Math.max(0, newCenterX - container.clientWidth / 2);
    const targetTop = Math.max(0, newCenterY - container.clientHeight / 2);

    container.scrollTo({
      left: targetLeft,
      top: targetTop
    });

    previousZoomRef.current = mapZoom;
  }, [mapZoom, floorplanSize]);

  const handleResetView = () => {
    setMapZoom(1);
    setSeatScale(1);
    previousZoomRef.current = 1;
    requestAnimationFrame(() => {
      if (floorplanRef.current) {
        floorplanRef.current.scrollTo({ left: 0, top: 0, behavior: "smooth" });
      }
    });
  };

  const handleOpenFloorplanPicker = () => {
    floorplanFileInputRef.current?.click();
  };

  const handleFloorSelect = (event: ChangeEvent<HTMLSelectElement>) => {
    const parsed = Number(event.target.value);
    if (Number.isFinite(parsed)) {
      const normalized = Math.max(1, Math.trunc(parsed));
      setSelectedFloor(normalized);
      if (!floorplans[normalized]) {
        void fetchFloorplanInfo(normalized);
      }
    }
  };

  const handleApplyFloorCount = async () => {
    const parsed = Number(floorCountInput);
    if (!Number.isFinite(parsed)) {
      setStatusBanner({
        type: "error",
        message: "Floor count must be a valid number."
      });
      return;
    }

    const normalized = Math.max(1, Math.min(20, Math.trunc(parsed)));
    if (normalized !== parsed) {
      setFloorCountInput(String(normalized));
    }

    if (buildingInfo && normalized === buildingInfo.floorCount) {
      setStatusBanner({ type: "info", message: "Floor count is already up to date." });
      return;
    }

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (adminSecret) {
        headers["x-admin-secret"] = adminSecret;
      }

      const body = {
        floorCount: normalized,
        floors: buildingInfo?.floors.map((floor) => ({ index: floor.index, name: floor.name }))
      };

      const response = await fetch(`${API_BASE_URL}/api/building`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        if (response.status === 401) {
          handleAdminUnauthorized();
          return;
        }
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          typeof payload?.message === "string"
            ? payload.message
            : `Failed to update floors (status ${response.status}).`
        );
      }

      const payload = (await response.json()) as BuildingInfo;
      setBuildingInfo(payload);
      setFloorCountInput(String(payload.floorCount));
      const nextFloorplans: Record<number, FloorplanInfoResponse> = {};
      payload.floors.forEach((floor) => {
        nextFloorplans[floor.index] = {
          floor: floor.index,
          hasCustomImage: floor.hasFloorplan,
          imageUrl: resolveApiPath(floor.imageUrl),
          updatedAt: floor.updatedAt
        };
      });
      setFloorplans(nextFloorplans);
      setSelectedFloor((current) => {
        if (payload.floors.some((floor) => floor.index === current)) {
          return current;
        }
        return payload.floors[0]?.index ?? 1;
      });
      await fetchSeats();
      setStatusBanner({
        type: "success",
        message: `Floor count updated to ${payload.floorCount}.`
      });
    } catch (error) {
      console.error(error);
      if (error instanceof Error && error.message === ADMIN_UNAUTHORIZED_ERROR) {
        handleAdminUnauthorized();
        return;
      }
      setStatusBanner({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to update floors."
      });
    }
  };

  const handleFloorplanFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) {
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setStatusBanner({
        type: "error",
        message: "The floor plan image must be 5 MB or smaller."
      });
      return;
    }

    const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      setStatusBanner({
        type: "error",
        message: "Only PNG, JPG or WEBP images are supported."
      });
      return;
    }

    try {
      setIsFloorplanUploading(true);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            resolve(reader.result);
          } else {
            reject(new Error("Failed to read the selected file."));
          }
        };
        reader.onerror = () => reject(new Error("Failed to read the selected file."));
        reader.readAsDataURL(file);
      });

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (adminSecret) {
        headers["x-admin-secret"] = adminSecret;
      }

      const response = await fetch(`${API_BASE_URL}/api/floorplans/${selectedFloor}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          dataUrl,
          name: file.name
        })
      });

      if (!response.ok) {
        if (response.status === 401) {
          handleAdminUnauthorized();
          return;
        }
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          typeof payload?.message === "string"
            ? payload.message
            : `Failed to upload the floor plan (status ${response.status}).`
        );
      }

      const payload: FloorplanInfoResponse = await response.json();
      const resolved: FloorplanInfoResponse = {
        ...payload,
        imageUrl: resolveApiPath(payload.imageUrl)
      };
      setFloorplans((current) => ({
        ...current,
        [selectedFloor]: resolved
      }));
      setBuildingInfo((current) =>
        current
          ? {
              ...current,
              floors: current.floors.map((floor) =>
                floor.index === selectedFloor
                  ? {
                      ...floor,
                      hasFloorplan: resolved.hasCustomImage,
                      updatedAt: resolved.updatedAt,
                      imageUrl: resolved.imageUrl
                    }
                  : floor
              )
            }
          : current
      );
      handleResetView();
      setStatusBanner({
        type: "success",
        message: "Floor plan image has been updated."
      });
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        setStatusBanner({ type: "error", message: error.message });
      } else {
        setStatusBanner({
          type: "error",
          message: "Failed to upload the floor plan image."
        });
      }
    } finally {
      setIsFloorplanUploading(false);
    }
  };

  const handleFloorplanRemove = async () => {
    try {
      setIsFloorplanDeleting(true);
      const headers: Record<string, string> = {};
      if (adminSecret) {
        headers["x-admin-secret"] = adminSecret;
      }

      const response = await fetch(`${API_BASE_URL}/api/floorplans/${selectedFloor}`, {
        method: "DELETE",
        headers
      });

      if (!response.ok) {
        if (response.status === 401) {
          handleAdminUnauthorized();
          return;
        }
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          typeof payload?.message === "string"
            ? payload.message
            : `Failed to remove the floor plan (status ${response.status}).`
        );
      }

      const payload: FloorplanInfoResponse = await response.json();
      const resolved: FloorplanInfoResponse = {
        ...payload,
        imageUrl: resolveApiPath(payload.imageUrl)
      };
      setFloorplans((current) => ({
        ...current,
        [selectedFloor]: resolved
      }));
      setBuildingInfo((current) =>
        current
          ? {
              ...current,
              floors: current.floors.map((floor) =>
                floor.index === selectedFloor
                  ? {
                      ...floor,
                      hasFloorplan: resolved.hasCustomImage,
                      updatedAt: resolved.updatedAt,
                      imageUrl: resolved.imageUrl
                    }
                  : floor
              )
            }
          : current
      );
      handleResetView();
      setStatusBanner({
        type: "success",
        message: "Custom floor plan image has been removed."
      });
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        setStatusBanner({ type: "error", message: error.message });
      } else {
        setStatusBanner({
          type: "error",
          message: "Failed to remove the floor plan image."
        });
      }
    } finally {
      setIsFloorplanDeleting(false);
    }
  };

  const handleToggleEditorMode = async () => {
    if (isEditorMode) {
      setIsEditorMode(false);
      const fitValues = getAutoFitView();
      if (fitValues) {
        previousZoomRef.current = fitValues.zoomValue;
        setMapZoom(fitValues.zoomValue);
        setSeatScale(fitValues.seatScaleValue);
      } else {
        previousZoomRef.current = 1;
        setMapZoom(1);
        setSeatScale(1);
      }
      return;
    }

    const ensureAuthorized = async (): Promise<boolean> => {
      if (isEditorAuthorized) {
        return true;
      }

      const existingSecret = adminSecret ?? "";
      try {
        const result = await verifyAdminSecret(existingSecret);
        setIsEditorAuthorized(true);
        setAdminSecret(
          result.passwordRequired && existingSecret ? existingSecret : null
        );
        return true;
      } catch {
        if (existingSecret) {
          handleAdminUnauthorized();
        }
      }

      const password = window.prompt("Enter the password for edit mode:");
      if (password === null) {
        return false;
      }

      try {
        const result = await verifyAdminSecret(password);
        setAdminSecret(result.passwordRequired ? password : null);
        setIsEditorAuthorized(true);
        return true;
      } catch (verifyError) {
        setStatusBanner({
          type: "error",
          message:
            verifyError instanceof Error
              ? verifyError.message
              : "The password is not valid."
        });
        return false;
      }
    };

    try {
      const authorized = await ensureAuthorized();
      if (authorized) {
        setIsEditorMode(true);
        setStatusBanner(null);
      }
    } catch (error) {
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to verify the password."
      });
    }
  };

  const handleSeatClick = (seatId: string) => {
    const seat = seatsRef.current.find((item) => item.id === seatId);
    if (seat) {
      setSelectedFloor(seat.floor);
    }
    setSelectedSeatId(seatId);
    setDraftSeat(null);
    setStatusBanner(null);
  };

  const handleSeatPointerDown = (
    seatId: string,
    event: React.PointerEvent<HTMLButtonElement>
  ) => {
    if (!isEditorMode) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const seat = seatsRef.current.find((item) => item.id === seatId);
    if (!seat) {
      return;
    }

    const normalizedSeat = {
      ...seat,
      x: normalizeCoordinate(seat.x),
      y: normalizeCoordinate(seat.y)
    };
    dragOriginalSeatRef.current = normalizedSeat;
    dragLatestPositionRef.current = { x: normalizedSeat.x, y: normalizedSeat.y };
    setDraggingSeatId(seatId);
    setSelectedSeatId(seatId);
    setDraftSeat(null);
    setStatusBanner(null);
  };

  const handleStartDrawSeat = () => {
    if (isDrawingSeat) {
      setIsDrawingSeat(false);
      setDraftDrawingRect(null);
      setStatusBanner(null);
      return;
    }
    if (!isEditorMode) {
      setIsEditorMode(true);
    }
    setDraftSeat(null);
    setSeatEditorDraft(null);
    setSelectedSeatId(null);
    setIsDrawingSeat(true);
    setDraftDrawingRect(null);
    setStatusBanner({
      type: "info",
      message: "Click and drag on the floor plan to draw the seat area."
    });
  };

  const getPointerPositionPercent = (event: { clientX: number; clientY: number }) => {
    const rect = floorplanContentRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }
    const rawX = ((event.clientX - rect.left) / rect.width) * 100;
    const rawY = ((event.clientY - rect.top) / rect.height) * 100;
    return {
      x: normalizeCoordinate(rawX),
      y: normalizeCoordinate(rawY)
    };
  };

const finalizeDraftFromRect = (rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}) => {
  const safeWidth = Math.max(0.5, Math.min(100, rect.width));
  const safeHeight = Math.max(0.5, Math.min(100, rect.height));
  const centerX = normalizeCoordinate(rect.left + safeWidth / 2);
  const centerY = normalizeCoordinate(rect.top + safeHeight / 2);
  setDraftSeat({
    id: "",
    label: "",
    x: centerX,
    y: centerY,
    width: Math.round(safeWidth * 100) / 100,
    height: Math.round(safeHeight * 100) / 100,
    rotation: 0,
    floor: selectedFloor,
    zone: "",
    notes: ""
  });
  setSeatEditorDraft(null);
  setSelectedSeatId(null);
  setStatusBanner({
    type: "info",
    message: "Seat area captured. Review the details and save."
  });
};

const handleSeatResizePointerMove = useCallback((event: PointerEvent) => {
  const state = resizingStateRef.current;
  if (!state) {
    return;
  }
  const pointer = getPointerPositionPercent(event);
  if (!pointer) {
    return;
  }

  const original = state.original;
  const cos = state.cos;
  const sin = state.sin;
  const pointerLocal = toLocalCoordinates(original, pointer, cos, sin);
  const fixedLocal = state.fixedLocal;

  const diffX = fixedLocal.x - pointerLocal.x;
  const diffY = fixedLocal.y - pointerLocal.y;

  let width = Math.abs(diffX);
  let height = Math.abs(diffY);

  const minSize = MIN_SEAT_SIZE;
  width = Math.min(100, Math.max(minSize, width));
  height = Math.min(100, Math.max(minSize, height));

  const directionX = diffX >= 0 ? 1 : -1;
  const directionY = diffY >= 0 ? 1 : -1;

  const adjustedPointerLocalX = fixedLocal.x - directionX * width;
  const adjustedPointerLocalY = fixedLocal.y - directionY * height;

  const centerLocal = {
    x: (adjustedPointerLocalX + fixedLocal.x) / 2,
    y: (adjustedPointerLocalY + fixedLocal.y) / 2
  };

  const newCenterWorld = fromLocalCoordinates(original, centerLocal, cos, sin);
  const normalizedCenterX = clampPercentage(newCenterWorld.x);
  const normalizedCenterY = clampPercentage(newCenterWorld.y);
  const roundedWidth = roundToTwoDecimals(width);
  const roundedHeight = roundToTwoDecimals(height);

  if (state.target === "seat") {
    const seatId = state.seatId;
    setSeats((existing) =>
      existing.map((seat) =>
        seat.id === seatId
          ? {
              ...seat,
              x: normalizeCoordinate(normalizedCenterX),
              y: normalizeCoordinate(normalizedCenterY),
              width: roundedWidth,
              height: roundedHeight,
              rotation: seat.rotation ?? state.original.rotation
            }
          : seat
      )
    );
    setSeatEditorDraft((current) =>
      current && current.id === seatId
        ? {
            ...current,
            x: normalizeCoordinate(normalizedCenterX),
            y: normalizeCoordinate(normalizedCenterY),
            width: roundedWidth,
            height: roundedHeight,
            rotation: current.rotation ?? state.original.rotation
          }
        : current
    );
  } else {
    setDraftSeat((current) =>
      current
        ? {
            ...current,
            x: normalizeCoordinate(normalizedCenterX),
            y: normalizeCoordinate(normalizedCenterY),
            width: roundedWidth,
            height: roundedHeight
          }
        : current
    );
  }

  state.hasChanges = true;
}, []);

const handleSeatResizePointerUp = useCallback(async () => {
  const state = resizingStateRef.current;
  if (!state) {
    return;
  }
  window.removeEventListener("pointermove", handleSeatResizePointerMove);
  window.removeEventListener("pointerup", handleSeatResizePointerUp);
  resizingStateRef.current = null;
  setActiveResizeTarget(null);

  if (!state.hasChanges) {
    return;
  }

  if (state.target === "seat") {
    const latestSeat = seatsRef.current.find((seat) => seat.id === state.seatId);
    if (!latestSeat) {
      return;
    }
    try {
      await updateSeatOnServer(state.seatId, {
        x: latestSeat.x,
        y: latestSeat.y,
        width: latestSeat.width,
        height: latestSeat.height,
        rotation: latestSeat.rotation
      });
    } catch (error) {
      console.error(error);
      if (error instanceof Error && error.message === ADMIN_UNAUTHORIZED_ERROR) {
        handleAdminUnauthorized();
      } else {
        setStatusBanner({
          type: "error",
          message: error instanceof Error ? error.message : "Failed to update the seat."
        });
      }
    }
  }
}, [handleAdminUnauthorized, handleSeatResizePointerMove, setStatusBanner, updateSeatOnServer]);

const handleSeatResizePointerDown = (
  target: "seat" | "draft",
  seatData: Seat | SeatDraft,
  handle: SeatResizeHandle,
  event: React.PointerEvent
) => {
  if (!isEditorMode) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();

  const rotation = seatData.rotation ?? 0;
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfWidth = (seatData.width ?? 6) / 2;
  const halfHeight = (seatData.height ?? 6) / 2;
  const config = RESIZE_HANDLE_CONFIG[handle];
  const fixedLocal = {
    x: config.fixed.x * halfWidth,
    y: config.fixed.y * halfHeight
  };

  resizingStateRef.current =
    target === "seat"
      ? {
          target: "seat",
          seatId: (seatData as Seat).id,
          handle,
          original: seatData as Seat,
          fixedLocal,
          cos,
          sin,
          hasChanges: false
        }
      : {
          target: "draft",
          handle,
          original: seatData as SeatDraft,
          fixedLocal,
          cos,
          sin,
          hasChanges: false
        };

  setActiveResizeTarget(target === "seat" ? (seatData as Seat).id : "draft");
  setIsDrawingSeat(false);
  setDraftDrawingRect(null);
  drawingStartRef.current = null;

  if (target === "seat") {
    setSelectedSeatId((seatData as Seat).id);
  }

  window.addEventListener("pointermove", handleSeatResizePointerMove);
  window.addEventListener("pointerup", handleSeatResizePointerUp);
};

const renderResizeHandles = (
  target: "seat" | "draft",
  seatData: Seat | SeatDraft,
  show: boolean
) => {
  if (!show) {
    return null;
  }
  return SEAT_RESIZE_HANDLES.map((handle) => (
    <span
      key={handle}
      className={`seat-resize-handle seat-resize-${handle}`}
      style={{ cursor: RESIZE_HANDLE_CONFIG[handle].cursor }}
      onPointerDown={(event) => handleSeatResizePointerDown(target, seatData, handle, event)}
    />
  ));
};

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", handleSeatResizePointerMove);
      window.removeEventListener("pointerup", handleSeatResizePointerUp);
    };
  }, [handleSeatResizePointerMove, handleSeatResizePointerUp]);

  const handleFloorplanPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isEditorMode || !isDrawingSeat) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    const start = getPointerPositionPercent(event);
    if (!start) {
      return;
    }
    drawingStartRef.current = start;
    setDraftDrawingRect({ left: start.x, top: start.y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleFloorplanPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawingStartRef.current) {
      return;
    }
    const current = getPointerPositionPercent(event);
    if (!current) {
      return;
    }
    event.preventDefault();
    const start = drawingStartRef.current;
    const left = Math.min(start.x, current.x);
    const top = Math.min(start.y, current.y);
    const width = Math.abs(current.x - start.x);
    const height = Math.abs(current.y - start.y);
    setDraftDrawingRect({ left, top, width, height });
  };

  const handleFloorplanPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawingStartRef.current) {
      return;
    }
    event.preventDefault();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch (releaseError) {
      console.warn(releaseError);
    }
    setIsDrawingSeat(false);
    setDraftDrawingRect(null);
    const start = drawingStartRef.current;
    drawingStartRef.current = null;
    const end = getPointerPositionPercent(event) ?? start;
    if (!start || !end) {
      return;
    }
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);

    if (width < 0.5 && height < 0.5) {
      // Treat as a simple click
      setDraftSeat({
        id: "",
        label: "",
        x: normalizeCoordinate(end.x),
        y: normalizeCoordinate(end.y),
        width: 6,
        height: 6,
        rotation: 0,
        floor: selectedFloor,
        zone: "",
        notes: ""
      });
      setSeatEditorDraft(null);
      setSelectedSeatId(null);
      setStatusBanner({
        type: "info",
        message: "Seat added. Adjust details if needed."
      });
      return;
    }

    finalizeDraftFromRect({ left, top, width, height });
  };

  const handleFloorplanClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isDrawingSeat || draftDrawingRect) {
      return;
    }
    if (!isEditorMode || !draftSeat) {
      return;
    }
    if (!floorplanRef.current) {
      return;
    }
    const rect = floorplanContentRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const rawX = ((event.clientX - rect.left) / rect.width) * 100;
    const rawY = ((event.clientY - rect.top) / rect.height) * 100;
    const relativeX = normalizeCoordinate(rawX);
    const relativeY = normalizeCoordinate(rawY);
    setDraftSeat((current) =>
      current ? { ...current, x: relativeX, y: relativeY } : current
    );
  };

  const handleStartCreateSeat = () => {
    if (!isEditorMode) {
      setIsEditorMode(true);
    }
    setIsDrawingSeat(false);
    setDraftDrawingRect(null);
    setDraftSeat({
      id: "",
      label: "",
      x: 50,
      y: 50,
      width: 8,
      height: 6,
      rotation: 0,
      floor: selectedFloor,
      zone: "",
      notes: ""
    });
    setSeatEditorDraft(null);
    setSelectedSeatId(null);
    setStatusBanner({
      type: "info",
      message: "Click the floor plan to place the new seat."
    });
  };

  const handleDraftSeatChange = (field: keyof SeatDraft, value: string) => {
    setDraftSeat((current) => {
      if (!current) {
        return current;
      }
      if (field === "x" || field === "y") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return current;
        }
        return { ...current, [field]: normalizeCoordinate(numeric) };
      }
      if (field === "width" || field === "height") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return current;
        }
        const normalized = Math.max(0.5, Math.min(100, Math.round(numeric * 100) / 100));
        return { ...current, [field]: normalized };
      }
      if (field === "rotation") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return current;
        }
        const normalized = Math.trunc(((numeric % 360) + 360) % 360);
        return { ...current, rotation: normalized };
      }
      if (field === "floor") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return current;
        }
        const normalized = Math.max(1, Math.trunc(numeric));
        setSelectedFloor(normalized);
        return { ...current, floor: normalized };
      }
      return { ...current, [field]: value };
    });
  };

  const handleCreateSeatSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draftSeat) {
      return;
    }

    const trimmedId = draftSeat.id.trim();
    if (!trimmedId) {
      setStatusBanner({
        type: "error",
        message: "The new seat must have an ID."
      });
      return;
    }

    if (seats.some((seat) => seat.id === trimmedId)) {
      setStatusBanner({
        type: "error",
        message: `Seat with ID "${trimmedId}" already exists. Please choose another.`
      });
      return;
    }

    const trimmedLabel = (draftSeat.label ?? "").trim();
    const trimmedZone = (draftSeat.zone ?? "").trim();
    const trimmedNotes = (draftSeat.notes ?? "").trim();

    try {
      const created = await createSeatOnServer({
        id: trimmedId,
        label: trimmedLabel || trimmedId,
        x: normalizeCoordinate(draftSeat.x),
        y: normalizeCoordinate(draftSeat.y),
        width: draftSeat.width,
        height: draftSeat.height,
        rotation: draftSeat.rotation,
        floor: draftSeat.floor,
        zone: trimmedZone,
        notes: trimmedNotes
      });

      setDraftSeat(null);
      setSelectedFloor(created.floor);
      setSelectedSeatId(created.id);
      setSeatEditorDraft({
        id: created.id,
        label: created.label,
        x: created.x,
        y: created.y,
        width: created.width,
        height: created.height,
        rotation: created.rotation,
        floor: created.floor,
        zone: created.zone ?? "",
        notes: created.notes ?? ""
      });
      setStatusBanner({
        type: "success",
        message: `Seat ${created.label} has been created.`
      });
    } catch (error) {
      console.error(error);
      if (error instanceof Error && error.message === ADMIN_UNAUTHORIZED_ERROR) {
        handleAdminUnauthorized();
        return;
      }
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to save the new seat."
      });
    }
  };

  const handleCancelDraft = () => {
    setDraftSeat(null);
    setDraftDrawingRect(null);
    setIsDrawingSeat(false);
    setStatusBanner(null);
  };

  const handleSeatEditorChange = (field: keyof SeatDraft, value: string) => {
    setSeatEditorDraft((current) => {
      if (!current) {
        return current;
      }

      if (field === "x" || field === "y") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return current;
        }
        return { ...current, [field]: normalizeCoordinate(numeric) };
      }

      if (field === "width" || field === "height") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return current;
        }
        const normalized = Math.max(0.5, Math.min(100, Math.round(numeric * 100) / 100));
        return { ...current, [field]: normalized };
      }

      if (field === "rotation") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return current;
        }
        const normalized = Math.trunc(((numeric % 360) + 360) % 360);
        return { ...current, rotation: normalized };
      }

      if (field === "floor") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return current;
        }
        const normalized = Math.max(1, Math.trunc(numeric));
        setSelectedFloor(normalized);
        return { ...current, floor: normalized };
      }

      return { ...current, [field]: value };
    });
  };

  const handleSeatEditorSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!seatEditorDraft) {
      return;
    }

    const trimmedLabel = seatEditorDraft.label.trim();
    if (!trimmedLabel) {
      setStatusBanner({
        type: "error",
        message: "Seat name cannot be empty."
      });
      return;
    }

    const trimmedZone = (seatEditorDraft.zone ?? "").trim();
    const trimmedNotes = (seatEditorDraft.notes ?? "").trim();

    try {
      await updateSeatOnServer(seatEditorDraft.id, {
        label: trimmedLabel,
        x: seatEditorDraft.x,
        y: seatEditorDraft.y,
        width: seatEditorDraft.width,
        height: seatEditorDraft.height,
        rotation: seatEditorDraft.rotation,
        floor: seatEditorDraft.floor,
        zone: trimmedZone,
        notes: trimmedNotes
      });
      setSeatEditorDraft((current) =>
        current
          ? {
              ...current,
              label: trimmedLabel,
              x: normalizeCoordinate(seatEditorDraft.x),
              y: normalizeCoordinate(seatEditorDraft.y),
              width: seatEditorDraft.width,
              height: seatEditorDraft.height,
              rotation: seatEditorDraft.rotation,
              floor: Math.max(1, Math.trunc(seatEditorDraft.floor)),
              zone: trimmedZone,
              notes: trimmedNotes
            }
          : current
      );
      setStatusBanner({
        type: "success",
        message: `Changes for seat ${trimmedLabel} have been saved.`
      });
    } catch (error) {
      console.error(error);
      if (error instanceof Error && error.message === ADMIN_UNAUTHORIZED_ERROR) {
        handleAdminUnauthorized();
        return;
      }
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to update the seat."
      });
    }
  };

  const handleDeleteSeat = async () => {
    if (!seatEditorDraft) {
      return;
    }

    const confirmed = window.confirm(
      `Are you sure you want to delete seat ${seatEditorDraft.label}? This action cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    try {
      await deleteSeatOnServer(seatEditorDraft.id);
      setSeatEditorDraft(null);
      setSelectedSeatId(null);
      setStatusBanner({
        type: "info",
        message: `Seat ${seatEditorDraft.label} has been removed.`
      });
    } catch (error) {
      console.error(error);
      if (error instanceof Error && error.message === ADMIN_UNAUTHORIZED_ERROR) {
        handleAdminUnauthorized();
        return;
      }
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to remove the seat."
      });
    }
  };

  const handleRepeatFrequencyChange = (frequency: RecurrenceFrequency) => {
    setRepeatFrequency(frequency);
    if (frequency === "none") {
      setRepeatCount(1);
      setRepeatCountInput("1");
      return;
    }

    setRepeatCount((current) => {
      const minimumApplied = current < 2 ? 2 : current;
      const normalized = Math.min(minimumApplied, MAX_RECURRENCE_OCCURRENCES);
      setRepeatCountInput(String(normalized));
      return normalized;
    });
  };

  const handleRepeatCountChange = (value: string) => {
    if (value === "") {
      setRepeatCountInput("");
      return;
    }

    if (!/^\d+$/.test(value)) {
      return;
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return;
    }

    const clamped = Math.min(MAX_RECURRENCE_OCCURRENCES, Math.trunc(numeric));
    const minAllowed = repeatFrequency === "none" ? 1 : 2;

    if (numeric > MAX_RECURRENCE_OCCURRENCES) {
      setRepeatCountInput(String(clamped));
      setRepeatCount(clamped);
      return;
    }

    setRepeatCountInput(value);

    if (numeric >= minAllowed) {
      setRepeatCount(clamped);
    }
  };

  const handleRepeatCountBlur = () => {
    const minAllowed = repeatFrequency === "none" ? 1 : 2;
    if (repeatCountInput === "") {
      setRepeatCount(minAllowed);
      setRepeatCountInput(String(minAllowed));
      return;
    }

    const numeric = Number(repeatCountInput);
    if (!Number.isFinite(numeric)) {
      const fallback = String(minAllowed);
      setRepeatCount(minAllowed);
      setRepeatCountInput(fallback);
      return;
    }

    const normalized = Math.min(
      MAX_RECURRENCE_OCCURRENCES,
      Math.max(minAllowed, Math.trunc(numeric))
    );
    setRepeatCount(normalized);
    setRepeatCountInput(String(normalized));
  };

  const resolveRecurrenceOptions = useCallback(() => {
    const normalizedCount = Math.min(
      MAX_RECURRENCE_OCCURRENCES,
      Math.max(1, Math.trunc(repeatCount))
    );
    if (normalizedCount !== repeatCount) {
      setRepeatCount(normalizedCount);
      setRepeatCountInput(String(normalizedCount));
    }

    const recurrencePayload =
      repeatFrequency !== "none" && normalizedCount > 1
        ? { frequency: repeatFrequency, count: normalizedCount }
        : undefined;

    return { normalizedCount, recurrencePayload };
  }, [repeatCount, repeatFrequency]);

  const submitBookingRequest = useCallback(
    async ({ skipConflicts = false }: { skipConflicts?: boolean } = {}) => {
      if (!selectedSeat) {
        setStatusBanner({
          type: "error",
          message: "Select a seat on the map before creating a booking."
        });
        return;
      }

      const trimmedName = nameInput.trim();
      if (!trimmedName) {
        setStatusBanner({
          type: "error",
          message: "Please enter the name to book the seat under."
        });
        return;
      }

      const { recurrencePayload } = resolveRecurrenceOptions();

      const requestBody: Record<string, unknown> = {
        seatId: selectedSeat.id,
        date: selectedDate,
        userName: trimmedName
      };

      if (recurrencePayload) {
        requestBody.recurrence = recurrencePayload;
      }
      if (skipConflicts) {
        requestBody.skipConflicts = true;
      }

      setIsBookingSubmitting(true);

      try {
        const response = await fetch(`${API_BASE_URL}/api/bookings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody)
        });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          if (response.status === 409) {
            const conflicts = extractConflicts(payload);
            const preview =
              payload && typeof payload === "object"
                ? extractPreview((payload as Record<string, unknown>).preview)
                : null;
            setConflictContext({
              conflicts,
              preview
            });
            if (preview) {
              setBookingPreview(preview);
            }

            const message =
              payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).message === "string"
                ? ((payload as Record<string, unknown>).message as string)
                : `Seat ${selectedSeat.label} is not available for ${conflicts.length} occurrence(s).`;

            setStatusBanner({
              type: "error",
              message
            });
            return;
          }

          throw new Error(
            payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).message === "string"
              ? ((payload as Record<string, unknown>).message as string)
              : `Booking failed (status ${response.status}).`
          );
        }

        const createdBookings = extractCreatedBookings(payload);
        if (createdBookings.length === 0) {
          throw new Error("Booking was created, but the server response was unexpected.");
        }

        const bookingsForSelectedDate = createdBookings.filter(
          (booking) => booking.date === selectedDate
        );

        if (bookingsForSelectedDate.length > 0) {
          setBookings((existing) => {
            const filtered = existing.filter(
              (booking) =>
                !bookingsForSelectedDate.some(
                  (created) => created.date === booking.date && created.seatId === booking.seatId
                )
            );
            return [...filtered, ...bookingsForSelectedDate];
          });
        }

        setAllBookings((existing) => {
          const filtered = existing.filter(
            (booking) => !createdBookings.some((created) => created.id === booking.id)
          );
          return [...filtered, ...createdBookings];
        });

        setConflictContext(null);

        const previewFromPayload =
          payload && typeof payload === "object"
            ? extractPreview((payload as Record<string, unknown>).preview)
            : null;
        setBookingPreview(previewFromPayload);

        const sortedCreatedBookings = [...createdBookings].sort((a, b) =>
          a.date.localeCompare(b.date)
        );

        const firstDate = sortedCreatedBookings[0]?.date ?? selectedDate;
        const lastDate =
          sortedCreatedBookings[sortedCreatedBookings.length - 1]?.date ?? selectedDate;

        const serverMessage =
          payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).message === "string"
            ? ((payload as Record<string, unknown>).message as string)
            : null;

        const successMessage =
          serverMessage ??
          (createdBookings.length === 1
            ? `Seat ${selectedSeat.label} is now booked for ${trimmedName}.`
            : `Seat ${selectedSeat.label} is now booked ${createdBookings.length} times for ${trimmedName} (from ${formatDateForDisplay(
                firstDate
              )} to ${formatDateForDisplay(lastDate)}).`);

        setStatusBanner({
          type: "success",
          message: successMessage
        });
      } catch (error) {
        console.error(error);
        setStatusBanner({
          type: "error",
          message:
            error instanceof Error ? error.message : "Failed to create the booking."
        });
      } finally {
        setIsBookingSubmitting(false);
      }
    },
    [
      nameInput,
      resolveRecurrenceOptions,
      selectedDate,
      selectedSeat,
      setBookings,
      setAllBookings,
      setStatusBanner,
      setConflictContext,
      setBookingPreview
    ]
  );

  const handleBookingSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void submitBookingRequest();
    },
    [submitBookingRequest]
  );

  const handleSkipConflictsSubmit = useCallback(() => {
    void submitBookingRequest({ skipConflicts: true });
  }, [submitBookingRequest]);

  const handleBookingPreview = useCallback(async () => {
    if (!selectedSeat) {
      setStatusBanner({
        type: "error",
        message: "Select a seat on the map before previewing availability."
      });
      return;
    }

    const { recurrencePayload } = resolveRecurrenceOptions();

    const requestBody: Record<string, unknown> = {
      seatId: selectedSeat.id,
      date: selectedDate
    };

    if (recurrencePayload) {
      requestBody.recurrence = recurrencePayload;
    }

    setIsPreviewLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/bookings/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).message === "string"
            ? ((payload as Record<string, unknown>).message as string)
            : `Preview failed (status ${response.status}).`
        );
      }

      const preview = extractPreview(payload);
      if (!preview) {
        throw new Error("Preview response was not in the expected format.");
      }

      setBookingPreview(preview);
      setConflictContext(
        preview.conflicts.length > 0 ? { conflicts: preview.conflicts, preview } : null
      );

      const infoMessage =
        preview.conflicts.length === 0
          ? `All ${preview.requestedCount} requested dates are available.`
          : `${preview.available.length}/${preview.requestedCount} requested dates are available.`;

      setStatusBanner({
        type: "info",
        message: infoMessage
      });
    } catch (error) {
      console.error(error);
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to preview the booking."
      });
    } finally {
      setIsPreviewLoading(false);
    }
  }, [
    resolveRecurrenceOptions,
    selectedDate,
    selectedSeat,
    setBookingPreview,
    setConflictContext,
    setStatusBanner
  ]);

  const handleApplyAdjustedStart = useCallback(
    (startDate: string) => {
      setSelectedDate(startDate);
      setConflictContext(null);
      setStatusBanner({
        type: "info",
        message: `Start date updated to ${formatDateForDisplay(startDate)}.`
      });
    },
    [setConflictContext, setSelectedDate, setStatusBanner]
  );

  const handleApplyShortenSuggestion = useCallback(
    (count: number) => {
      if (!Number.isFinite(count) || count < 1) {
        return;
      }
      const normalized = Math.min(MAX_RECURRENCE_OCCURRENCES, Math.max(1, Math.trunc(count)));
      setRepeatCount(normalized);
      setRepeatCountInput(String(normalized));
      if (normalized === 1) {
        setRepeatFrequency("none");
      }
      setConflictContext(null);
      setStatusBanner({
        type: "info",
        message: `Recurrence length updated to ${normalized} occurrence${
          normalized === 1 ? "" : "s"
        }.`
      });
    },
    [setConflictContext, setRepeatCount, setRepeatCountInput, setRepeatFrequency, setStatusBanner]
  );

  const handleApplyContiguousSuggestion = useCallback(
    (startDate: string, count: number, frequency: BookingPreview["recurrence"]["frequency"]) => {
      if (!Number.isFinite(count) || count < 1) {
        return;
      }
      setSelectedDate(startDate);
      const normalizedCount = Math.min(MAX_RECURRENCE_OCCURRENCES, Math.max(1, Math.trunc(count)));
      setRepeatCount(normalizedCount);
      setRepeatCountInput(String(normalizedCount));
      if (frequency === "daily" || frequency === "weekday" || frequency === "weekly") {
        setRepeatFrequency(frequency);
      } else if (normalizedCount === 1) {
        setRepeatFrequency("none");
      }
      setConflictContext(null);
      setStatusBanner({
        type: "info",
        message: `Using the suggested series starting ${formatDateForDisplay(
          startDate
        )} with ${normalizedCount} occurrence${normalizedCount === 1 ? "" : "s"}.`
      });
    },
    [
      setConflictContext,
      setRepeatCount,
      setRepeatCountInput,
      setRepeatFrequency,
      setSelectedDate,
      setStatusBanner
    ]
  );

  const handleCancelBooking = async () => {
    if (!selectedSeatBooking) {
      return;
    }

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/bookings/${selectedSeatBooking.id}`,
        {
          method: "DELETE"
        }
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          payload?.message ?? `Canceling the booking failed (status ${response.status}).`
        );
      }

      setBookings((existing) =>
        existing.filter((booking) => booking.id !== selectedSeatBooking.id)
      );
      setAllBookings((existing) =>
        existing.filter((booking) => booking.id !== selectedSeatBooking.id)
      );
      setConflictContext(null);
      setStatusBanner({
        type: "info",
        message: `Booking for ${selectedSeatBooking.userName} has been canceled.`
      });
    } catch (error) {
      console.error(error);
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to cancel the booking."
      });
    }
  };

  const handleCancelSeries = async () => {
    if (!selectedSeatBooking?.seriesId) {
      return;
    }

    const confirmed = window.confirm(
      "Cancel all remaining occurrences in this series? This cannot be undone."
    );

    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/bookings/series/${selectedSeatBooking.seriesId}`,
        {
          method: "DELETE"
        }
      );

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).message === "string"
            ? ((payload as Record<string, unknown>).message as string)
            : `Canceling the series failed (status ${response.status}).`
        );
      }

      const removed = Array.isArray((payload as Record<string, unknown>).removed)
        ? ((payload as Record<string, unknown>).removed as Array<Record<string, unknown>>)
            .filter((item) => typeof item === "object" && typeof item.id === "string")
            .map((item) => ({
              id: item.id as string,
              date: typeof item.date === "string" ? item.date : undefined
            }))
        : [];

      if (removed.length > 0) {
        setBookings((existing) =>
          existing.filter(
            (booking) => !removed.some((entry) => entry.id === booking.id)
          )
        );
        setAllBookings((existing) =>
          existing.filter(
            (booking) => !removed.some((entry) => entry.id === booking.id)
          )
        );
      }

      setConflictContext(null);
      setStatusBanner({
        type: "info",
        message:
          removed.length > 0
            ? `Canceled ${removed.length} remaining occurrence${
                removed.length === 1 ? "" : "s"
              } in this series.`
            : "No future occurrences remained in this series."
      });
    } catch (error) {
      console.error(error);
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to cancel the series."
      });
    }
  };

  const isSeatBooked = (seatId: string) =>
    bookings.some((booking) => booking.seatId === seatId);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <img
            src="/logo.png"
            alt="FloorFlow logo"
            className="app-logo"
            width={80}
            height={80}
          />
          <div>
            <h1>Shared Desk Reservations</h1>
            <p>
              Pick a date and click the floor plan to reserve a workspace.
            </p>
          </div>
        </div>
        <div className="header-actions">
          <label className="date-picker">
            <span>Selected day</span>
            <input
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={`toolbar-button ${isEditorMode ? "toolbar-active" : ""}`}
            onClick={handleToggleEditorMode}
          >
            {isEditorMode ? "Exit editing" : "Edit mode"}
          </button>
          <button
            type="button"
            className="toolbar-button subtle"
            onClick={() => navigate("/stats")}
          >
            Statistics
          </button>
        </div>
        {isEditorMode ? (
          <div className="edit-toolbar">
            <div className="edit-toolbar-group">
              <span className="edit-toolbar-label">Seat tools</span>
              <div className="edit-toolbar-actions">
                <button
                  type="button"
                  className="toolbar-button subtle"
                  onClick={handleStartCreateSeat}
                  disabled={Boolean(draftSeat) || isDrawingSeat}
                >
                  Add new seat
                </button>
                <button
                  type="button"
                  className={`toolbar-button subtle${isDrawingSeat ? " toolbar-active" : ""}`}
                  onClick={handleStartDrawSeat}
                >
                  {isDrawingSeat ? "Stop drawing" : "Draw seat area"}
                </button>
              </div>
            </div>
            <div className="edit-toolbar-group">
              <span className="edit-toolbar-label">Building</span>
              <div className="edit-toolbar-actions edit-toolbar-column">
                <label className="floor-count-field">
                  <span>Total floors</span>
                  <div className="floor-count-controls">
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={floorCountInput}
                      onChange={(event) => setFloorCountInput(event.target.value)}
                    />
                    <button
                      type="button"
                      className="toolbar-button subtle"
                      onClick={handleApplyFloorCount}
                      disabled={isFloorplanUploading || isFloorplanDeleting}
                    >
                      Update count
                    </button>
                  </div>
                </label>
                <span className="floorplan-hint">Allowed range: 1–20 floors.</span>
              </div>
            </div>
            <div className="edit-toolbar-group">
              <span className="edit-toolbar-label">
                Floor plan image ({currentFloorName})
              </span>
              <div className="edit-toolbar-actions">
                <input
                  ref={floorplanFileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  style={{ display: "none" }}
                  onChange={handleFloorplanFileChange}
                />
                <button
                  type="button"
                  className="toolbar-button subtle"
                  onClick={handleOpenFloorplanPicker}
                  disabled={isFloorplanUploading || isFloorplanDeleting}
                >
                  {isFloorplanUploading
                    ? "Uploading..."
                    : hasCustomFloorplan
                    ? "Change image"
                    : "Upload image"}
                </button>
                {hasCustomFloorplan ? (
                  <button
                    type="button"
                    className="toolbar-button danger"
                    onClick={handleFloorplanRemove}
                    disabled={isFloorplanUploading || isFloorplanDeleting}
                  >
                    {isFloorplanDeleting ? "Removing..." : "Remove image"}
                  </button>
                ) : null}
              </div>
              <span className="floorplan-hint">
                Accepted: PNG, JPG or WEBP · max 5 MB ·{" "}
                {hasCustomFloorplan
                  ? `custom image in use for ${currentFloorName}`
                  : `using default image for ${currentFloorName}`}
              </span>
            </div>
          </div>
        ) : null}
      </header>

      {statusBanner ? (
        <div className={`status-banner status-${statusBanner.type}`}>
          {statusBanner.message}
        </div>
      ) : null}

      <main className="app-layout">
        <section className="map-panel">
          <div className="floor-switcher">
            <label htmlFor="floor-select">
              <span>Floor</span>
              <select id="floor-select" value={selectedFloor} onChange={handleFloorSelect}>
                {availableFloors.map((floor) => (
                  <option key={floor.index} value={floor.index}>
                    {floor.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="floorplan-container">
            <div
              className={`floorplan-canvas${isEditorMode ? " floorplan-editing" : ""}`}
              ref={floorplanRef}
              onClick={handleFloorplanClick}
            >
              <div
                className="floorplan-content"
                style={floorplanContentStyle}
                ref={floorplanContentRef}
                onPointerDown={handleFloorplanPointerDown}
                onPointerMove={handleFloorplanPointerMove}
                onPointerUp={handleFloorplanPointerUp}
              >
                <img
                  key={floorplanImageUrl}
                  src={floorplanImageUrl}
                  alt="Office floor plan"
                  className="floorplan-image"
                  draggable={false}
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    if (image.naturalWidth && image.naturalHeight) {
                      setFloorplanSize({
                        width: image.naturalWidth,
                        height: image.naturalHeight
                      });
                      const containerWidth = floorplanRef.current?.clientWidth ?? image.naturalWidth;
                      const ratio = containerWidth / image.naturalWidth;
                      if (Number.isFinite(ratio) && ratio > 0) {
                        const zoomValue = Math.min(2, Math.max(0.3, Number(ratio.toFixed(2))));
                        previousZoomRef.current = zoomValue;
                        setMapZoom(zoomValue);
                        const scaleValue = Math.min(1.5, Math.max(0.6, Number(ratio.toFixed(2))));
                        setSeatScale(scaleValue);
                      }
                    }
                  }}
                />
                {draftDrawingRect ? (
                  <div
                    className="seat-drawing-overlay"
                    style={{
                      left: `${draftDrawingRect.left}%`,
                      top: `${draftDrawingRect.top}%`,
                      width: `${draftDrawingRect.width}%`,
                      height: `${draftDrawingRect.height}%`
                    }}
                  />
                ) : null}
                {!isLoadingSeats && seatsOnFloor.length > 0
                  ? seatsOnFloor.map((seat) => {
                      const isBooked = isSeatBooked(seat.id);
                      const isSelected = seat.id === selectedSeatId;
                      const showHandles =
                        isEditorMode &&
                        (isSelected || activeResizeTarget === seat.id);
                      const seatWrapperStyle: SeatStyle = {
                        left: `${seat.x}%`,
                        top: `${seat.y}%`,
                        width: `${seat.width}%`,
                        height: `${seat.height}%`,
                        "--seat-scale": seatScale.toFixed(2),
                        "--seat-rotation": `${seat.rotation ?? 0}deg`
                      };
                      return (
                        <div
                          key={seat.id}
                          className={[
                            "seat-wrapper",
                            isEditorMode ? "seat-editor" : "",
                            draggingSeatId === seat.id ? "seat-dragging" : ""
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          style={seatWrapperStyle}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleSeatClick(seat.id);
                          }}
                        >
                          <button
                            type="button"
                            className={[
                              "seat-button",
                              isBooked ? "seat-booked" : "seat-available",
                              isSelected ? "seat-selected" : ""
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            onPointerDown={(event) => handleSeatPointerDown(seat.id, event)}
                          >
                            <span className="seat-label">{seat.label}</span>
                            {isEditorMode ? (
                              <span className="seat-coords">
                                {seat.x.toFixed(1)}%, {seat.y.toFixed(1)}% · {seat.width.toFixed(1)}×
                                {seat.height.toFixed(1)}% · {seat.rotation.toFixed(0)}°
                              </span>
                            ) : null}
                          </button>
                          {renderResizeHandles("seat", seat, showHandles)}
                        </div>
                      );
                    })
                  : null}
                {draftSeat && draftSeat.floor === selectedFloor ? (
                  <div
                    className="seat-wrapper seat-draft"
                    style={{
                      left: `${draftSeat.x}%`,
                      top: `${draftSeat.y}%`,
                      width: `${draftSeat.width}%`,
                      height: `${draftSeat.height}%`,
                      "--seat-scale": seatScale.toFixed(2),
                      "--seat-rotation": `${draftSeat.rotation ?? 0}deg`
                    } as SeatStyle}
                  >
                    <button type="button" className="seat-button">
                      <span className="seat-label">
                        {draftSeat.label ? draftSeat.label : "New seat"}
                      </span>
                      <span className="seat-coords">
                        {draftSeat.x.toFixed(1)}%, {draftSeat.y.toFixed(1)}% ·
                        {draftSeat.width.toFixed(1)}×{draftSeat.height.toFixed(1)}% ·
                        {draftSeat.rotation.toFixed(0)}°
                      </span>
                    </button>
                    {renderResizeHandles("draft", draftSeat, isEditorMode)}
                  </div>
                ) : null}
              </div>
              {isEditorMode ? (
                <div className="editor-mode-badge">
                  Edit mode - drag an existing seat or click to add a new one.
                </div>
              ) : null}
              {isLoadingSeats ? (
                <div className="loading">Loading seat layout...</div>
              ) : seats.length === 0 ? (
                <div className="loading">
                  No seat definitions found. Add them to{" "}
                  <code>server/data/seats.json</code>.
                </div>
              ) : null}
            </div>
            <footer className="map-legend">
              <div className="legend-item">
                <span className="legend-swatch legend-free" />
                Available seat
              </div>
              <div className="legend-item">
                <span className="legend-swatch legend-occupied" />
                Booked seat
              </div>
              <div className="legend-item">
                <span className="legend-swatch legend-selected" />
                Selected seat
              </div>
            </footer>
          </div>
        </section>

        <section className="details-section">
          <div className="details-grid">
            <div className="sidebar-section">
            <h2>
              {isEditorMode
                ? draftSeat
                  ? "New seat"
                  : seatEditorDraft
                  ? `Editing ${seatEditorDraft.label || seatEditorDraft.id}`
                  : "Select a seat on the map"
                : selectedSeat
                ? `Seat ${selectedSeat.label}`
                : "Select a seat on the map"}
            </h2>
            {isEditorMode ? (
              <>
                {draftSeat ? (
                  <>
                    <p className="editor-hint">
                      Fill in the details. You can adjust the coordinates by clicking the floor plan.
                    </p>
                    <form className="editor-form" onSubmit={handleCreateSeatSubmit}>
                      <label>
                        Seat ID
                        <input
                          value={draftSeat.id}
                          onChange={(event) => handleDraftSeatChange("id", event.target.value)}
                          placeholder="e.g. 54-2"
                          required
                        />
                      </label>
                      <label>
                        Label
                        <input
                          value={draftSeat.label}
                          onChange={(event) => handleDraftSeatChange("label", event.target.value)}
                          placeholder="Text shown on the map"
                        />
                      </label>
                      <label>
                        Zone
                        <input
                          value={draftSeat.zone ?? ""}
                          onChange={(event) => handleDraftSeatChange("zone", event.target.value)}
                          placeholder="Optional area label"
                        />
                      </label>
                      <label>
                        Note
                        <textarea
                          rows={2}
                          value={draftSeat.notes ?? ""}
                          onChange={(event) => handleDraftSeatChange("notes", event.target.value)}
                          placeholder="Short internal note"
                        />
                      </label>
                      <div className="editor-grid">
                        <label>
                          X coordinate (%)
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            value={draftSeat.x}
                            onChange={(event) => handleDraftSeatChange("x", event.target.value)}
                          />
                        </label>
                        <label>
                          Y coordinate (%)
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            value={draftSeat.y}
                            onChange={(event) => handleDraftSeatChange("y", event.target.value)}
                          />
                        </label>
                        <label>
                          Floor
                          <select
                            value={draftSeat.floor}
                            onChange={(event) => handleDraftSeatChange("floor", event.target.value)}
                          >
                            {availableFloors.map((floor) => (
                              <option key={floor.index} value={floor.index}>
                                {floor.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Width (%)
                          <input
                            type="number"
                            min={0.5}
                            max={100}
                            step={0.01}
                            value={draftSeat.width}
                            onChange={(event) => handleDraftSeatChange("width", event.target.value)}
                          />
                        </label>
                        <label>
                          Height (%)
                          <input
                            type="number"
                            min={0.5}
                            max={100}
                            step={0.01}
                            value={draftSeat.height}
                            onChange={(event) => handleDraftSeatChange("height", event.target.value)}
                          />
                        </label>
                        <label>
                          Rotation (°)
                          <input
                            type="number"
                            min={0}
                            max={359}
                            step={1}
                            value={draftSeat.rotation}
                            onChange={(event) => handleDraftSeatChange("rotation", event.target.value)}
                          />
                        </label>
                      </div>
                      <div className="editor-actions">
                        <button type="submit" className="primary">
                          Save new seat
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={handleCancelDraft}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  </>
                ) : seatEditorDraft ? (
                  <>
                    <p className="editor-hint">
                      You can move the seat directly on the map by dragging it. X/Y values are percentages of the image width and height.
                    </p>
                    <form className="editor-form" onSubmit={handleSeatEditorSubmit}>
                      <label>
                        ID
                        <input value={seatEditorDraft.id} disabled readOnly />
                      </label>
                      <label>
                        Name
                        <input
                          value={seatEditorDraft.label}
                          onChange={(event) =>
                            handleSeatEditorChange("label", event.target.value)
                          }
                          required
                        />
                      </label>
                      <label>
                        Zone
                        <input
                          value={seatEditorDraft.zone ?? ""}
                          onChange={(event) => handleSeatEditorChange("zone", event.target.value)}
                        />
                      </label>
                      <label>
                        Note
                        <textarea
                          rows={2}
                          value={seatEditorDraft.notes ?? ""}
                          onChange={(event) => handleSeatEditorChange("notes", event.target.value)}
                        />
                      </label>
                      <div className="editor-grid">
                        <label>
                          X coordinate (%)
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            value={seatEditorDraft.x}
                            onChange={(event) => handleSeatEditorChange("x", event.target.value)}
                          />
                        </label>
                        <label>
                          Y coordinate (%)
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            value={seatEditorDraft.y}
                            onChange={(event) => handleSeatEditorChange("y", event.target.value)}
                          />
                        </label>
                        <label>
                          Floor
                          <select
                            value={seatEditorDraft.floor}
                            onChange={(event) => handleSeatEditorChange("floor", event.target.value)}
                          >
                            {availableFloors.map((floor) => (
                              <option key={floor.index} value={floor.index}>
                                {floor.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Width (%)
                          <input
                            type="number"
                            min={0.5}
                            max={100}
                            step={0.01}
                            value={seatEditorDraft.width}
                            onChange={(event) => handleSeatEditorChange("width", event.target.value)}
                          />
                        </label>
                        <label>
                          Height (%)
                          <input
                            type="number"
                            min={0.5}
                            max={100}
                            step={0.01}
                            value={seatEditorDraft.height}
                            onChange={(event) => handleSeatEditorChange("height", event.target.value)}
                          />
                        </label>
                        <label>
                          Rotation (°)
                          <input
                            type="number"
                            min={0}
                            max={359}
                            step={1}
                            value={seatEditorDraft.rotation}
                            onChange={(event) => handleSeatEditorChange("rotation", event.target.value)}
                          />
                        </label>
                      </div>
                      <div className="editor-actions">
                        <button type="submit" className="primary">
                          Save changes
                        </button>
                        <button type="button" className="danger" onClick={handleDeleteSeat}>
                          Delete seat
                        </button>
                      </div>
                    </form>
                  </>
                ) : (
                  <p className="muted">
                    Click a seat on the map or use "Add new seat".
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="selected-date">{formatDateForDisplay(selectedDate)}</p>
                {selectedSeat ? (
                  <>
                    <p className="muted">
                      Floor: <strong>{getFloorName(selectedSeat.floor)}</strong>
                    </p>
                    {selectedSeat.zone ? (
                      <p className="muted">
                        Zone: <strong>{selectedSeat.zone}</strong>
                      </p>
                    ) : null}
                    {selectedSeat.notes ? (
                      <p className="muted">{selectedSeat.notes}</p>
                    ) : null}
                    {selectedSeatBooking ? (
                      <div className="booking-card">
                        <p>
                          Currently booked by:{" "}
                          <strong>{selectedSeatBooking.userName}</strong>
                        </p>
                        <p className="muted">
                          Created:{" "}
                          {new Intl.DateTimeFormat("en-US", {
                            dateStyle: "short",
                            timeStyle: "short"
                          }).format(new Date(selectedSeatBooking.createdAt))}
                        </p>
                        <button
                          type="button"
                          className="secondary"
                          onClick={handleCancelBooking}
                        >
                          Cancel booking
                        </button>
                        {selectedSeatBooking.seriesId ? (
                          <button
                            type="button"
                            className="link-button"
                            onClick={handleCancelSeries}
                          >
                            Cancel remaining occurrences
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <div className="booking-flow">
                        <form className="booking-form" onSubmit={handleBookingSubmit}>
                          <label htmlFor="userName">
                            Name or initials
                            <input
                              id="userName"
                              name="userName"
                              value={nameInput}
                              onChange={(event) => setNameInput(event.target.value)}
                              placeholder="e.g. John Smith"
                              autoComplete="name"
                            />
                          </label>
                          <label htmlFor="repeatFrequency">
                            Repeat
                            <select
                              id="repeatFrequency"
                              name="repeatFrequency"
                              value={repeatFrequency}
                              onChange={(event) =>
                                handleRepeatFrequencyChange(event.target.value as RecurrenceFrequency)
                              }
                            >
                              <option value="none">Do not repeat</option>
                              <option value="daily">Every day</option>
                              <option value="weekday">Every weekday (Mon–Fri)</option>
                              <option value="weekly">Every week</option>
                            </select>
                            <span className="field-hint">
                              Choose how often this reservation should repeat.
                            </span>
                          </label>
                          <label htmlFor="repeatCount">
                            Number of occurrences
                            <input
                              id="repeatCount"
                              name="repeatCount"
                              type="number"
                              min={repeatFrequency === "none" ? 1 : 2}
                              max={MAX_RECURRENCE_OCCURRENCES}
                              value={repeatCountInput}
                              disabled={repeatFrequency === "none"}
                              onChange={(event) => handleRepeatCountChange(event.target.value)}
                              onBlur={handleRepeatCountBlur}
                            />
                            <span className="field-hint">
                              Includes the selected date. Maximum {MAX_RECURRENCE_OCCURRENCES}.
                            </span>
                          </label>
                          <div className="booking-actions">
                            <button
                              type="submit"
                              className="primary"
                              disabled={isBookingSubmitting}
                            >
                              {isBookingSubmitting ? "Booking…" : "Book this seat"}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={handleBookingPreview}
                              disabled={isBookingSubmitting || isPreviewLoading}
                            >
                              {isPreviewLoading ? "Checking…" : "Preview availability"}
                            </button>
                          </div>
                        </form>
                        {conflictContext ? (
                          <div className="conflict-banner">
                            <p>
                              Seat {selectedSeat?.label ?? selectedSeatId ?? "selected seat"} is not
                              available for {conflictContext.conflicts.length} occurrence
                              {conflictContext.conflicts.length === 1 ? "" : "s"}.
                            </p>
                            {conflictContext.conflicts.length > 0 ? (
                              <ul className="conflict-list">
                                {conflictContext.conflicts.slice(0, 5).map((conflict) => (
                                  <li key={conflict.bookingId}>
                                    {formatDateForDisplay(conflict.date)} — {conflict.userName}
                                  </li>
                                ))}
                                {conflictContext.conflicts.length > 5 ? (
                                  <li>
                                    …and {conflictContext.conflicts.length - 5} more conflicts.
                                  </li>
                                ) : null}
                              </ul>
                            ) : null}
                            <div className="conflict-actions">
                              <button
                                type="button"
                                className="primary"
                                onClick={handleSkipConflictsSubmit}
                                disabled={isBookingSubmitting}
                              >
                                {isBookingSubmitting ? "Saving…" : "Book available days only"}
                              </button>
                              {conflictContext.preview?.suggestions.adjustStart?.startDate ? (
                                <button
                                  type="button"
                                  className="secondary"
                                  onClick={() =>
                                    handleApplyAdjustedStart(
                                      conflictContext.preview?.suggestions.adjustStart?.startDate ??
                                        selectedDate
                                    )
                                  }
                                >
                                  Find nearest free series
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                        {bookingPreview ? (
                          <div className="preview-summary">
                            <h4>Availability preview</h4>
                            <p>
                              {bookingPreview.available.length} of {bookingPreview.requestedCount} requested
                              date{bookingPreview.requestedCount === 1 ? "" : "s"} are available.
                            </p>
                            {bookingPreview.conflicts.length > 0 ? (
                              <ul className="conflict-list">
                                {bookingPreview.conflicts.slice(0, 5).map((conflict) => (
                                  <li key={`preview-${conflict.bookingId}`}>
                                    {formatDateForDisplay(conflict.date)} — {conflict.userName}
                                  </li>
                                ))}
                                {bookingPreview.conflicts.length > 5 ? (
                                  <li>
                                    …and {bookingPreview.conflicts.length - 5} more conflicts.
                                  </li>
                                ) : null}
                              </ul>
                            ) : (
                              <p className="muted">No conflicts detected.</p>
                            )}
                            <div className="preview-suggestions">
                              {bookingPreview.suggestions.shorten &&
                              bookingPreview.suggestions.shorten.count > 0 &&
                              bookingPreview.suggestions.shorten.count < bookingPreview.requestedCount ? (
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() =>
                                    handleApplyShortenSuggestion(
                                      bookingPreview.suggestions.shorten!.count
                                    )
                                  }
                                >
                                  Shorten series to {bookingPreview.suggestions.shorten.count} occurrence
                                  {bookingPreview.suggestions.shorten.count === 1 ? "" : "s"}
                                </button>
                              ) : null}
                              {bookingPreview.suggestions.contiguousBlock ? (
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() =>
                                    handleApplyContiguousSuggestion(
                                      bookingPreview.suggestions.contiguousBlock!.startDate,
                                      bookingPreview.suggestions.contiguousBlock!.count,
                                      bookingPreview.recurrence.frequency
                                    )
                                  }
                                >
                                  Use free block from{" "}
                                  {formatDateForDisplay(
                                    bookingPreview.suggestions.contiguousBlock.startDate
                                  )}{" "}
                                  ({bookingPreview.suggestions.contiguousBlock.count} occurrence
                                  {bookingPreview.suggestions.contiguousBlock.count === 1 ? "" : "s"})
                                </button>
                              ) : null}
                              {bookingPreview.suggestions.adjustStart?.startDate ? (
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() =>
                                    handleApplyAdjustedStart(
                                      bookingPreview.suggestions.adjustStart!.startDate
                                    )
                                  }
                                >
                                  Shift start to{" "}
                                  {formatDateForDisplay(
                                    bookingPreview.suggestions.adjustStart.startDate
                                  )}
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="seat-suggestions">
                    <p className="muted">
                      {totalAvailableSeats > 0
                        ? "Pick one of the free seats below or tap the map to explore more options."
                        : "Every seat is booked for this day. Try another date to find an open spot."}
                    </p>
                    {suggestedSeats.length > 0 ? (
                      <div className="available-seat-suggestions">
                        <h4>Available today</h4>
                        <ul className="available-seat-list">
                          {suggestedSeats.map((seat) => {
                            const seatLabel = seat.label || seat.id;
                            const details: string[] = [getFloorName(seat.floor)];
                            if (seat.zone) {
                              details.push(`Zone ${seat.zone}`);
                            }
                            const detailText = details.join(" | ");
                            return (
                              <li key={seat.id}>
                                <button
                                  type="button"
                                  className="available-seat-item"
                                  onClick={() => handleSeatClick(seat.id)}
                                >
                                  <span className="available-seat-label">{seatLabel}</span>
                                  <span className="available-seat-details">{detailText}</span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                        {totalAvailableSeats > suggestedSeats.length ? (
                          <p className="available-seat-note muted">
                            {totalAvailableSeats - suggestedSeats.length === 1
                              ? "1 more seat is free today - see the map for the rest."
                              : `${totalAvailableSeats - suggestedSeats.length} more seats are free today - see the map for the rest.`}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )}
              </>
            )}
            </div>

            <div className="sidebar-section">
              <h3>Bookings on this day</h3>
              {anyDataLoading ? (
                <p className="muted">Loading…</p>
              ) : sortedBookings.length === 0 ? (
                <p className="muted">No bookings yet.</p>
              ) : (
                <ul className="booking-list">
                  {sortedBookings.map((booking) => {
                    const seat = seats.find((item) => item.id === booking.seatId);
                    const seatLabel = seat ? seat.label : booking.seatId;
                    const isSelected = selectedSeatId === booking.seatId;
                    return (
                      <li key={booking.id}>
                        <button
                          type="button"
                          className={`booking-item${isSelected ? " booking-item-selected" : ""}`}
                          onClick={() => handleSeatClick(booking.seatId)}
                          aria-pressed={isSelected}
                        >
                          <span className="booking-seat">{seatLabel}</span>
                          <span className="booking-user">{booking.userName}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="user-column">
              <div className="sidebar-section user-list-section">
                <h3>Users with reservations</h3>
                {isLoadingAllBookings ? (
                  <p className="muted">Loading…</p>
                ) : usersWithBookings.length === 0 ? (
                  <p className="muted">Nobody has a reservation yet.</p>
                ) : (
                  <div className="user-chip-list">
                    {usersWithBookings.map((user) => {
                      const isSelected = selectedUserName === user.userName;
                      return (
                        <button
                          key={user.userName}
                          type="button"
                          className={`user-chip${isSelected ? " user-selected" : ""}`}
                          onClick={() =>
                            setSelectedUserName((current) =>
                              current === user.userName ? null : user.userName
                            )
                          }
                          aria-pressed={isSelected}
                        >
                          <span className="user-name">{user.userName}</span>
                          <span className="user-count">{user.bookings.length}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="sidebar-section user-detail-section">
                {selectedUserName && selectedUserBookings.length > 0 ? (
                  <>
                    <div className="user-booking-summary">
                      <h4>{selectedUserName}</h4>
                      <span className="user-booking-total">
                        {selectedUserBookings.length} booking
                        {selectedUserBookings.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <ul className="user-booking-list">
                      {selectedUserBookings.map((booking) => {
                        const seatLabel = seatById.get(booking.seatId)?.label ?? booking.seatId;
                        const availableSeats = getAvailableSeatsForBooking(booking).filter(
                          (seat) => seat.id !== booking.seatId
                        );
                        const isBusy = bookingActionInFlight?.bookingId === booking.id;
                        const moveModeActive = bookingBeingRescheduledId === booking.id;
                        const moveTarget =
                          moveTargets[booking.id] ?? (availableSeats[0]?.id ?? "");

                        return (
                          <li key={booking.id} className="user-booking-item">
                            <div className="user-booking-info">
                              <span className="user-booking-date">
                                {formatDateForDisplay(booking.date)}
                              </span>
                              <span className="user-booking-seat">
                                Seat: <strong>{seatLabel}</strong>
                              </span>
                              {booking.seriesId ? (
                                <span className="user-booking-series">Recurring</span>
                              ) : null}
                            </div>
                            {moveModeActive ? (
                              availableSeats.length === 0 ? (
                                <div className="user-booking-actions">
                                  <p className="muted">No alternative seats available.</p>
                                  <button
                                    type="button"
                                    className="link-button"
                                    onClick={() => handleStartMoveBooking(booking)}
                                  >
                                    Close
                                  </button>
                                </div>
                              ) : (
                                <form
                                  className="user-move-form"
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    if (!moveTarget) {
                                      return;
                                    }
                                    void handleMoveBooking(booking, moveTarget);
                                  }}
                                >
                                  <label className="user-move-select">
                                    <span>New seat</span>
                                    <select
                                      value={moveTarget}
                                      onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                                        handleMoveTargetChange(booking.id, event.target.value)
                                      }
                                      disabled={isBusy}
                                    >
                                      {availableSeats.map((seat) => (
                                        <option key={seat.id} value={seat.id}>
                                          {seat.label ? `${seat.label} (${seat.id})` : seat.id}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <div className="user-move-actions">
                                    <button
                                      type="submit"
                                      className="primary"
                                      disabled={isBusy || !moveTarget}
                                    >
                                      {isBusy && bookingActionInFlight?.type === "move"
                                        ? "Moving…"
                                        : "Move booking"}
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary"
                                      disabled={isBusy}
                                      onClick={() => handleStartMoveBooking(booking)}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </form>
                              )
                            ) : (
                              <div className="user-booking-actions">
                                <button
                                  type="button"
                                  className="link-button"
                                  disabled={isBusy || availableSeats.length === 0}
                                  onClick={() => handleStartMoveBooking(booking)}
                                >
                                  {availableSeats.length === 0
                                    ? "No free seats"
                                    : "Move to another seat"}
                                </button>
                                <button
                                  type="button"
                                  className="danger-link"
                                  disabled={isBusy}
                                  onClick={() => void handleCancelUserBooking(booking)}
                                >
                                  {isBusy && bookingActionInFlight?.type === "cancel"
                                    ? "Canceling…"
                                    : "Cancel day"}
                                </button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : (
                  <p className="muted">
                    {usersWithBookings.length === 0
                      ? "Nobody has a reservation yet."
                      : "Select a user to manage their reservations."}
                  </p>
                )}
              </div>
            </div>

          </div>
        </section>

      </main>
    </div>
  );
}

function StatsPage() {
  const navigate = useNavigate();
  const [fromDate, setFromDate] = useState<string>(getDateNDaysAgo(29));
  const [toDate, setToDate] = useState<string>(getToday());
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    if (fromDate && toDate && fromDate > toDate) {
      setError("Start date must be before end date.");
      setSummary(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (fromDate) {
        params.set("from", fromDate);
      }
      if (toDate) {
        params.set("to", toDate);
      }

      const query = params.toString();
      const response = await fetch(
        `${API_BASE_URL}/api/analytics/summary${query ? `?${query}` : ""}`
      );
      if (!response.ok) {
        throw new Error(`Failed to load analytics (status ${response.status}).`);
      }
      const payload = (await response.json()) as AnalyticsSummary;
      setSummary(payload);
    } catch (fetchError) {
      console.error(fetchError);
      setError(
        fetchError instanceof Error ? fetchError.message : "Failed to load analytics."
      );
      setSummary(null);
    } finally {
      setIsLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  const handleQuickRange = useCallback((days: number) => {
    const end = getToday();
    const start = getDateNDaysAgo(Math.max(days - 1, 0));
    setToDate(end);
    setFromDate(start);
  }, []);

  const topSeats = useMemo(() => summary?.topSeats ?? [], [summary]);
  const topUsers = useMemo(() => summary?.topUsers ?? [], [summary]);
  const topCancellations = useMemo(() => summary?.topCancellations ?? [], [summary]);
  const busiestDays = useMemo(() => summary?.busiestDays ?? [], [summary]);
  const maxSeatCount = useMemo(
    () => topSeats.reduce((max, seat) => Math.max(max, seat.count), 0),
    [topSeats]
  );
  const maxUserCount = useMemo(
    () => topUsers.reduce((max, user) => Math.max(max, user.count), 0),
    [topUsers]
  );
  const maxCancellationCount = useMemo(
    () => topCancellations.reduce((max, cancellation) => Math.max(max, cancellation.count), 0),
    [topCancellations]
  );
  const maxBusyDayCount = useMemo(
    () => busiestDays.reduce((max, day) => Math.max(max, day.count), 0),
    [busiestDays]
  );

  return (
    <div className="stats-shell">
      <header className="stats-header">
        <div>
          <h1>Workspace Analytics</h1>
          <p>Understand booking patterns, popular seats, and team activity over time.</p>
        </div>
        <div className="stats-header-actions">
          <button
            type="button"
            className="toolbar-button subtle"
            onClick={() => navigate("/")}
          >
            Back to map
          </button>
        </div>
      </header>

      <section className="stats-filters">
        <div className="stats-date-range">
          <label>
            From
            <input
              type="date"
              value={fromDate}
              max={toDate}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={toDate}
              min={fromDate}
              max={getToday()}
              onChange={(event) => setToDate(event.target.value)}
            />
          </label>
        </div>
        <div className="stats-quick-ranges">
          <span>Quick ranges:</span>
          <button
            type="button"
            className="chip-button"
            onClick={() => handleQuickRange(7)}
          >
            Last 7 days
          </button>
          <button
            type="button"
            className="chip-button"
            onClick={() => handleQuickRange(30)}
          >
            Last 30 days
          </button>
          <button
            type="button"
            className="chip-button"
            onClick={() => handleQuickRange(90)}
          >
            Last 90 days
          </button>
          <button
            type="button"
            className="chip-button"
            onClick={() => {
              const now = new Date();
              const startOfYear = new Date(now.getFullYear(), 0, 1)
                .toISOString()
                .slice(0, 10);
              setFromDate(startOfYear);
              setToDate(getToday());
            }}
          >
            Year to date
          </button>
        </div>
      </section>

      {error ? (
        <div className="status-banner status-error">{error}</div>
      ) : null}

      {isLoading ? (
        <div className="stats-loading">Loading analytics…</div>
      ) : summary ? (
        <div className="stats-content">
          <section className="stats-overview">
            <div className="stat-card">
              <span className="stat-label">Bookings created</span>
              <span className="stat-value">{summary.totals.created}</span>
              <span className="stat-hint">during the selected period</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Bookings canceled</span>
              <span className="stat-value">{summary.totals.canceled}</span>
              <span className="stat-hint">tracked via cancellations</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Active bookings in range</span>
              <span className="stat-value">{summary.totals.active}</span>
              <span className="stat-hint">matching current data set</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Average per day</span>
              <span className="stat-value">
                {summary.averageDailyBookings.toFixed(1)}
              </span>
              <span className="stat-hint">bookings each day</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Unique people</span>
              <span className="stat-value">{summary.totals.uniqueUsers}</span>
              <span className="stat-hint">with reservations</span>
            </div>
          </section>

          <section className="stats-grid">
            <div className="stat-panel">
              <h3>Top seats</h3>
              {topSeats.length === 0 ? (
                <p className="muted">No bookings recorded for this period.</p>
              ) : (
                <ul className="stat-list">
                  {topSeats.map((seat) => (
                    <li key={seat.seatId}>
                      <div className="stat-item-row">
                        <div>
                          <strong>{seat.label || seat.seatId}</strong>
                          <span className="muted">Seat ID: {seat.seatId}</span>
                        </div>
                        <span className="stat-count">{seat.count}</span>
                      </div>
                      <div className="stat-bar" aria-hidden="true">
                        <div
                          className="stat-bar-fill"
                          style={{ width: `${calculateBarWidth(seat.count, maxSeatCount)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="stat-panel">
              <h3>Most active teammates</h3>
              {topUsers.length === 0 ? (
                <p className="muted">No reservations for this range.</p>
              ) : (
                <ul className="stat-list">
                  {topUsers.map((user) => (
                    <li key={user.userName}>
                      <div className="stat-item-row">
                        <span>{user.userName}</span>
                        <span className="stat-count">{user.count}</span>
                      </div>
                      <div className="stat-bar" aria-hidden="true">
                        <div
                          className="stat-bar-fill"
                          style={{ width: `${calculateBarWidth(user.count, maxUserCount)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="stat-panel">
              <h3>Cancellation leaders</h3>
              {topCancellations.length === 0 ? (
                <p className="muted">No cancellations captured in this range.</p>
              ) : (
                <ul className="stat-list">
                  {topCancellations.map((user) => (
                    <li key={`cancel-${user.userName}`}>
                      <div className="stat-item-row">
                        <span>{user.userName}</span>
                        <span className="stat-count">{user.count}</span>
                      </div>
                      <div className="stat-bar" aria-hidden="true">
                        <div
                          className="stat-bar-fill"
                          style={{
                            width: `${calculateBarWidth(user.count, maxCancellationCount)}%`
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="stat-panel">
              <h3>Busiest days</h3>
              {busiestDays.length === 0 ? (
                <p className="muted">No activity in the selected window.</p>
              ) : (
                <ul className="stat-list">
                  {busiestDays.map((day) => (
                    <li key={day.date}>
                      <div className="stat-item-row">
                        <span>{formatDateForDisplay(day.date)}</span>
                        <span className="stat-count">{day.count}</span>
                      </div>
                      <div className="stat-bar" aria-hidden="true">
                        <div
                          className="stat-bar-fill"
                          style={{ width: `${calculateBarWidth(day.count, maxBusyDayCount)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      ) : (
        <p className="muted">Select a valid range to load analytics.</p>
      )}
    </div>
  );
}

const requireAuthentication = (element) => {
    return (
        <PrivateRoute>
            {element}
        </PrivateRoute>
    )
}

function App() {
  return (
    <Routes>
      <Route path="/" element={requireAuthentication(<MainDashboard />, '/')} />
      <Route path="/stats" element={requireAuthentication(<StatsPage />, '/')} />
      <Route path="/login" element={<LoginRedirectPage />} />
    </Routes>
  );
}

export default App;
