import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type Seat = {
  id: string;
  label: string;
  x: number;
  y: number;
  zone?: string;
  notes?: string;
};

type Booking = {
  id: string;
  seatId: string;
  date: string;
  userName: string;
  createdAt: string;
};

type SeatDraft = {
  id: string;
  label: string;
  x: number;
  y: number;
  zone?: string;
  notes?: string;
};

type SeatStyle = CSSProperties & { "--seat-scale"?: string };

type StatusBanner =
  | { type: "success" | "info"; message: string }
  | { type: "error"; message: string }
  | null;

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
const ADMIN_UNAUTHORIZED_ERROR = "ADMIN_UNAUTHORIZED";

const formatDateForDisplay = (value: string) => {
  try {
    const asDate = new Date(value);
    return new Intl.DateTimeFormat("cs-CZ", {
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

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const normalizeCoordinate = (value: number) => Math.round(clamp(value, 0, 100) * 10) / 10;

function App() {
  const [seats, setSeats] = useState<Seat[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
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
  const [adminSecret, setAdminSecret] = useState<string | null>(null);
  const [isEditorAuthorized, setIsEditorAuthorized] = useState(false);
  const floorplanRef = useRef<HTMLDivElement | null>(null);
  const floorplanContentRef = useRef<HTMLDivElement | null>(null);
  const dragOriginalSeatRef = useRef<Seat | null>(null);
  const dragLatestPositionRef = useRef<{ x: number; y: number } | null>(null);
  const seatsRef = useRef<Seat[]>([]);
  const previousZoomRef = useRef(mapZoom);
  const userAdjustedZoomRef = useRef(false);
  const userAdjustedSeatScaleRef = useRef(false);

  useEffect(() => {
    seatsRef.current = seats;
  }, [seats]);

  const updateSeatOnServer = useCallback(
    async (seatId: string, updates: Partial<SeatDraft>) => {
      const payload: Record<string, unknown> = { ...updates };
      if (typeof updates.x === "number") {
        payload.x = normalizeCoordinate(updates.x);
      }
      if (typeof updates.y === "number") {
        payload.y = normalizeCoordinate(updates.y);
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
          payload?.message ?? `Aktualizace místa selhala (status ${response.status}).`
        );
      }

      const updatedSeat: Seat = await response.json();
      const normalizedSeat: Seat = {
        ...updatedSeat,
        x: normalizeCoordinate(updatedSeat.x),
        y: normalizeCoordinate(updatedSeat.y)
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
        y: normalizeCoordinate(seat.y)
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
          payload?.message ?? `Vytvoření místa selhalo (status ${response.status}).`
        );
      }

      const createdSeat: Seat = await response.json();
      const normalizedSeat: Seat = {
        ...createdSeat,
        x: normalizeCoordinate(createdSeat.x),
        y: normalizeCoordinate(createdSeat.y)
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
          payload?.message ?? `Smazání místa selhalo (status ${response.status}).`
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
      message: "Neplatné nebo vypršené heslo. Aktivujte režim editace znovu."
    });
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
        throw new Error(payload?.message ?? "Heslo není platné.");
      }

      return payload;
    },
    []
  );

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
        y: normalizeCoordinate(seat.y)
      }));
      setSeats(normalizedSeats);
    } catch (error) {
      console.error(error);
      setStatusBanner({
        type: "error",
        message: "Nepodařilo se načíst seznam míst. Zkuste to prosím znovu."
      });
    } finally {
      setIsLoadingSeats(false);
    }
  }, []);

  useEffect(() => {
    fetchSeats();
  }, [fetchSeats]);

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
      } catch (error) {
        console.error(error);
        setStatusBanner({
          type: "error",
          message: "Rezervace pro zvolený den se nepodařilo načíst."
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

  const selectedSeat = useMemo(
    () => (selectedSeatId ? seats.find((seat) => seat.id === selectedSeatId) ?? null : null),
    [seats, selectedSeatId]
  );

  const selectedSeatBooking = useMemo(
    () =>
      selectedSeatId ? bookings.find((booking) => booking.seatId === selectedSeatId) ?? null : null,
    [bookings, selectedSeatId]
  );

  useEffect(() => {
    if (!isEditorMode) {
      setDraftSeat(null);
      setSeatEditorDraft(null);
      setDraggingSeatId(null);
      dragOriginalSeatRef.current = null;
      dragLatestPositionRef.current = null;
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

      if (
        Math.abs(current.x - latestSeat.x) < 0.0001 &&
        Math.abs(current.y - latestSeat.y) < 0.0001
      ) {
        return current;
      }

      return {
        ...current,
        x: normalizeCoordinate(latestSeat.x),
        y: normalizeCoordinate(latestSeat.y)
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
          message: `Pozice místa ${original.label} byla uložena.`
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
            error instanceof Error ? error.message : "Pozici se nepodařilo uložit."
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

  const anyDataLoading = isLoadingSeats || isLoadingBookings;

  const sortedBookings = useMemo(
    () => [...bookings].sort((a, b) => a.seatId.localeCompare(b.seatId)),
    [bookings]
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

  const handleZoomChange = (value: string) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      userAdjustedZoomRef.current = true;
      setMapZoom(Number(parsed.toFixed(2)));
    }
  };

  const handleSeatScaleChange = (value: string) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      userAdjustedSeatScaleRef.current = true;
      setSeatScale(Number(parsed.toFixed(2)));
    }
  };

  const handleResetView = () => {
    setMapZoom(1);
    setSeatScale(1);
    previousZoomRef.current = 1;
    userAdjustedZoomRef.current = false;
    userAdjustedSeatScaleRef.current = false;
    requestAnimationFrame(() => {
      if (floorplanRef.current) {
        floorplanRef.current.scrollTo({ left: 0, top: 0, behavior: "smooth" });
      }
    });
  };

  const handleToggleEditorMode = async () => {
    if (isEditorMode) {
      setIsEditorMode(false);
      setMapZoom(1);
      setSeatScale(1);
      previousZoomRef.current = 1;
      userAdjustedZoomRef.current = false;
      userAdjustedSeatScaleRef.current = false;
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

      const password = window.prompt("Zadejte heslo pro režim editace:");
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
              : "Heslo není platné."
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
          error instanceof Error ? error.message : "Nepodařilo se ověřit heslo."
      });
    }
  };

  const handleSeatClick = (seatId: string) => {
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

  const handleFloorplanClick = (event: ReactMouseEvent<HTMLDivElement>) => {
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
    setDraftSeat({
      id: "",
      label: "",
      x: 50,
      y: 50,
      zone: "",
      notes: ""
    });
    setSeatEditorDraft(null);
    setSelectedSeatId(null);
    setStatusBanner({
      type: "info",
      message: "Klikněte do plánku a umístěte nové místo."
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
        message: "Nové místo musí mít vyplněné ID."
      });
      return;
    }

    if (seats.some((seat) => seat.id === trimmedId)) {
      setStatusBanner({
        type: "error",
        message: `Seat s ID "${trimmedId}" už existuje. Zvolte prosím jiné.`
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
        zone: trimmedZone,
        notes: trimmedNotes
      });

      setDraftSeat(null);
      setSelectedSeatId(created.id);
      setSeatEditorDraft({
        id: created.id,
        label: created.label,
        x: created.x,
        y: created.y,
        zone: created.zone ?? "",
        notes: created.notes ?? ""
      });
      setStatusBanner({
        type: "success",
        message: `Místo ${created.label} bylo vytvořeno.`
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
          error instanceof Error ? error.message : "Nové místo se nepodařilo uložit."
      });
    }
  };

  const handleCancelDraft = () => {
    setDraftSeat(null);
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
        message: "Název místa nesmí být prázdný."
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
              zone: trimmedZone,
              notes: trimmedNotes
            }
          : current
      );
      setStatusBanner({
        type: "success",
        message: `Změny pro místo ${trimmedLabel} byly uloženy.`
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
          error instanceof Error ? error.message : "Aktualizace místa se nezdařila."
      });
    }
  };

  const handleDeleteSeat = async () => {
    if (!seatEditorDraft) {
      return;
    }

    const confirmed = window.confirm(
      `Opravdu chcete odstranit místo ${seatEditorDraft.label}? Tuto akci nelze vrátit zpět.`
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
        message: `Místo ${seatEditorDraft.label} bylo odstraněno.`
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
          error instanceof Error ? error.message : "Místo se nepodařilo odstranit."
      });
    }
  };

  const handleCopySeatJson = async () => {
    if (!navigator.clipboard) {
      setStatusBanner({
        type: "error",
        message: "Prohlížeč nepodporuje kopírování do schránky."
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(seats, null, 2));
      setStatusBanner({
        type: "success",
        message: "Souřadnice míst byly zkopírovány do schránky."
      });
    } catch (error) {
      console.error(error);
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Souřadnice se nepodařilo zkopírovat."
      });
    }
  };

  const handleBookingSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedSeat) {
      return;
    }

    const trimmedName = nameInput.trim();
    if (!trimmedName) {
      setStatusBanner({
        type: "error",
        message: "Zadejte prosím jméno, pod kterým bude místo rezervováno."
      });
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seatId: selectedSeat.id,
          date: selectedDate,
          userName: trimmedName
        })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          payload?.message ?? `Rezervace se nezdařila (status ${response.status}).`
        );
      }

      const createdBooking: Booking = await response.json();
      setBookings((existing) => [...existing, createdBooking]);
      setStatusBanner({
        type: "success",
        message: `Místo ${selectedSeat.label} je nyní rezervováno pro ${trimmedName}.`
      });
    } catch (error) {
      console.error(error);
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Rezervaci se nepodařilo dokončit."
      });
    }
  };

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
          payload?.message ?? `Zrušení rezervace selhalo (status ${response.status}).`
        );
      }

      setBookings((existing) =>
        existing.filter((booking) => booking.id !== selectedSeatBooking.id)
      );
      setStatusBanner({
        type: "info",
        message: `Rezervace pro ${selectedSeatBooking.userName} byla zrušena.`
      });
    } catch (error) {
      console.error(error);
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Rezervaci se nepodařilo zrušit."
      });
    }
  };

  const isSeatBooked = (seatId: string) =>
    bookings.some((booking) => booking.seatId === seatId);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Rezervace sdílených míst</h1>
          <p>
            Vyberte datum a kliknutím do plánku si rezervujte konkrétní pracoviště.
          </p>
        </div>
        <div className="header-actions">
          <label className="date-picker">
            <span>Vybraný den</span>
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
            {isEditorMode ? "Ukončit editaci" : "Režim editace"}
          </button>
          {isEditorMode ? (
            <>
              <button
                type="button"
                className="toolbar-button subtle"
                onClick={handleStartCreateSeat}
                disabled={Boolean(draftSeat)}
              >
                Přidat nové místo
              </button>
              <button
                type="button"
                className="toolbar-button subtle"
                onClick={handleCopySeatJson}
              >
                Kopírovat souřadnice
              </button>
              <div className="editor-tuning">
                <label className="tuning-control">
                  <span>Zoom mapy</span>
                  <div className="slider-row">
                    <input
                      type="range"
                      min={0.3}
                      max={2}
                      step={0.1}
                      value={mapZoom}
                      onChange={(event) => handleZoomChange(event.target.value)}
                    />
                    <span className="slider-value">{Math.round(mapZoom * 100)}%</span>
                  </div>
                </label>
                <label className="tuning-control">
                  <span>Velikost značek</span>
                  <div className="slider-row">
                    <input
                      type="range"
                      min={0.6}
                      max={1.8}
                      step={0.1}
                      value={seatScale}
                      onChange={(event) => handleSeatScaleChange(event.target.value)}
                    />
                    <span className="slider-value">{Math.round(seatScale * 100)}%</span>
                  </div>
                </label>
                <button type="button" className="toolbar-button subtle" onClick={handleResetView}>
                  Reset pohledu
                </button>
              </div>
            </>
          ) : null}
        </div>
      </header>

      {statusBanner ? (
        <div className={`status-banner status-${statusBanner.type}`}>
          {statusBanner.message}
        </div>
      ) : null}

      <main className="app-layout">
        <section className="map-panel">
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
              >
                <img
                  src="/floorplan.png"
                  alt="Plánek kanceláře"
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
                        if (!userAdjustedZoomRef.current) {
                          previousZoomRef.current = zoomValue;
                          setMapZoom(zoomValue);
                        }
                        if (!userAdjustedSeatScaleRef.current) {
                          const scaleValue = Math.min(1.5, Math.max(0.6, Number(ratio.toFixed(2))));
                          setSeatScale(scaleValue);
                        }
                      }
                    }
                  }}
                />
                {!isLoadingSeats && seats.length > 0
                  ? seats.map((seat) => {
                      const isBooked = isSeatBooked(seat.id);
                      const isSelected = seat.id === selectedSeatId;
                      const seatStyle: SeatStyle = {
                        left: `${seat.x}%`,
                        top: `${seat.y}%`,
                        "--seat-scale": seatScale.toFixed(2)
                      };
                      return (
                        <button
                          key={seat.id}
                          type="button"
                          className={[
                            "seat-button",
                            isBooked ? "seat-booked" : "seat-available",
                            isSelected ? "seat-selected" : "",
                            isEditorMode ? "seat-editor" : "",
                            draggingSeatId === seat.id ? "seat-dragging" : ""
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          style={seatStyle}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleSeatClick(seat.id);
                          }}
                          onPointerDown={(event) => handleSeatPointerDown(seat.id, event)}
                        >
                          <span className="seat-label">{seat.label}</span>
                          {isEditorMode ? (
                            <span className="seat-coords">
                              {seat.x.toFixed(1)}%, {seat.y.toFixed(1)}%
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  : null}
                {draftSeat ? (
                  <div
                    className="seat-button seat-draft"
                    style={{
                      left: `${draftSeat.x}%`,
                      top: `${draftSeat.y}%`,
                      "--seat-scale": seatScale.toFixed(2)
                    } as SeatStyle}
                  >
                    <span className="seat-label">
                      {draftSeat.label ? draftSeat.label : "Nové místo"}
                    </span>
                    <span className="seat-coords">
                      {draftSeat.x.toFixed(1)}%, {draftSeat.y.toFixed(1)}%
                    </span>
                  </div>
                ) : null}
              </div>
              {isEditorMode ? (
                <div className="editor-mode-badge">
                  Režim editace – přetáhněte existující místo nebo kliknutím přidejte nové.
                </div>
              ) : null}
              {isLoadingSeats ? (
                <div className="loading">Načítám rozmístění míst…</div>
              ) : seats.length === 0 ? (
                <div className="loading">
                  Nenalezeny žádné definice míst. Přidejte je do souboru
                  <code> server/data/seats.json</code>.
                </div>
              ) : null}
            </div>
            <footer className="map-legend">
              <div className="legend-item">
                <span className="legend-swatch legend-free" />
                Volné místo
              </div>
              <div className="legend-item">
                <span className="legend-swatch legend-occupied" />
                Zabrané místo
              </div>
              <div className="legend-item">
                <span className="legend-swatch legend-selected" />
                Vybrané místo
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
                  ? "Nové místo"
                  : seatEditorDraft
                  ? `Editace ${seatEditorDraft.label || seatEditorDraft.id}`
                  : "Vyberte místo v plánku"
                : selectedSeat
                ? `Místo ${selectedSeat.label}`
                : "Vyberte místo v plánku"}
            </h2>
            {isEditorMode ? (
              <>
                {draftSeat ? (
                  <>
                    <p className="editor-hint">
                      Vyplňte detaily. Souřadnice můžete upřesnit i kliknutím do plánku.
                    </p>
                    <form className="editor-form" onSubmit={handleCreateSeatSubmit}>
                      <label>
                        ID místa
                        <input
                          value={draftSeat.id}
                          onChange={(event) => handleDraftSeatChange("id", event.target.value)}
                          placeholder="např. 54-2"
                          required
                        />
                      </label>
                      <label>
                        Popisek
                        <input
                          value={draftSeat.label}
                          onChange={(event) => handleDraftSeatChange("label", event.target.value)}
                          placeholder="Text zobrazovaný v plánku"
                        />
                      </label>
                      <label>
                        Zóna
                        <input
                          value={draftSeat.zone ?? ""}
                          onChange={(event) => handleDraftSeatChange("zone", event.target.value)}
                          placeholder="Volitelné označení části kanceláře"
                        />
                      </label>
                      <label>
                        Poznámka
                        <textarea
                          rows={2}
                          value={draftSeat.notes ?? ""}
                          onChange={(event) => handleDraftSeatChange("notes", event.target.value)}
                          placeholder="Krátká interní poznámka"
                        />
                      </label>
                      <div className="editor-grid">
                        <label>
                          Souřadnice X (%)
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
                          Souřadnice Y (%)
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            value={draftSeat.y}
                            onChange={(event) => handleDraftSeatChange("y", event.target.value)}
                          />
                        </label>
                      </div>
                      <div className="editor-actions">
                        <button type="submit" className="primary">
                          Uložit nové místo
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={handleCancelDraft}
                        >
                          Zrušit
                        </button>
                      </div>
                    </form>
                  </>
                ) : seatEditorDraft ? (
                  <>
                    <p className="editor-hint">
                      Místo jde posunout přímo v plánku přetažením myší. Hodnoty X/Y jsou v
                      procentech šířky a výšky obrázku.
                    </p>
                    <form className="editor-form" onSubmit={handleSeatEditorSubmit}>
                      <label>
                        ID
                        <input value={seatEditorDraft.id} disabled readOnly />
                      </label>
                      <label>
                        Název
                        <input
                          value={seatEditorDraft.label}
                          onChange={(event) =>
                            handleSeatEditorChange("label", event.target.value)
                          }
                          required
                        />
                      </label>
                      <label>
                        Zóna
                        <input
                          value={seatEditorDraft.zone ?? ""}
                          onChange={(event) => handleSeatEditorChange("zone", event.target.value)}
                        />
                      </label>
                      <label>
                        Poznámka
                        <textarea
                          rows={2}
                          value={seatEditorDraft.notes ?? ""}
                          onChange={(event) => handleSeatEditorChange("notes", event.target.value)}
                        />
                      </label>
                      <div className="editor-grid">
                        <label>
                          Souřadnice X (%)
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
                          Souřadnice Y (%)
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            value={seatEditorDraft.y}
                            onChange={(event) => handleSeatEditorChange("y", event.target.value)}
                          />
                        </label>
                      </div>
                      <div className="editor-actions">
                        <button type="submit" className="primary">
                          Uložit změny
                        </button>
                        <button type="button" className="danger" onClick={handleDeleteSeat}>
                          Smazat místo
                        </button>
                      </div>
                    </form>
                  </>
                ) : (
                  <p className="muted">
                    Klikněte v plánku na existující místo nebo použijte „Přidat nové místo“.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="selected-date">{formatDateForDisplay(selectedDate)}</p>
                {selectedSeat ? (
                  <>
                    {selectedSeat.zone ? (
                      <p className="muted">
                        Zóna: <strong>{selectedSeat.zone}</strong>
                      </p>
                    ) : null}
                    {selectedSeat.notes ? (
                      <p className="muted">{selectedSeat.notes}</p>
                    ) : null}
                    {selectedSeatBooking ? (
                      <div className="booking-card">
                        <p>
                          Aktuálně rezervuje:{" "}
                          <strong>{selectedSeatBooking.userName}</strong>
                        </p>
                        <p className="muted">
                          Vytvořeno:{" "}
                          {new Intl.DateTimeFormat("cs-CZ", {
                            dateStyle: "short",
                            timeStyle: "short"
                          }).format(new Date(selectedSeatBooking.createdAt))}
                        </p>
                        <button
                          type="button"
                          className="secondary"
                          onClick={handleCancelBooking}
                        >
                          Zrušit rezervaci
                        </button>
                      </div>
                    ) : (
                      <form className="booking-form" onSubmit={handleBookingSubmit}>
                        <label htmlFor="userName">
                          Jméno nebo zkratka
                          <input
                            id="userName"
                            name="userName"
                            value={nameInput}
                            onChange={(event) => setNameInput(event.target.value)}
                            placeholder="např. Jan Novák"
                            autoComplete="name"
                          />
                        </label>
                        <button type="submit" className="primary">
                          Rezervovat toto místo
                        </button>
                      </form>
                    )}
                  </>
                ) : (
                  <p className="muted">
                    Kliknutím v plánku zobrazíte detaily a můžete rezervovat.
                  </p>
                )}
              </>
            )}
            </div>

            <div className="sidebar-section">
            <h3>Rezervace v tento den</h3>
            {anyDataLoading ? (
              <p className="muted">Načítání…</p>
            ) : sortedBookings.length === 0 ? (
              <p className="muted">Ještě nikdo nic nezarezervoval.</p>
            ) : (
              <ul className="booking-list">
                {sortedBookings.map((booking) => {
                  const seat = seats.find((item) => item.id === booking.seatId);
                  return (
                    <li key={booking.id}>
                      <span className="booking-seat">
                        {seat ? seat.label : booking.seatId}
                      </span>
                      <span className="booking-user">{booking.userName}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
