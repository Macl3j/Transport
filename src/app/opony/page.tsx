"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import {
  CIAGNIK_POSITIONS,
  NACZEPA_POSITIONS,
  calcTireStatus,
  STATUS_COLORS,
  parseDOT,
  dotAgeYears,
  minTread,
  axleLabel,
  suggestDismountFate,
  REMOVAL_REASONS,
  TIRE_PURPOSE_LABELS,
  type Tire,
  type TireInspection,
  type TireReading,
  type TireWarehouseItem,
  type TirePositionDef,
  type TireStatus,
  type RemovalReason,
  type TirePurpose,
} from "@/lib/tireUtils";
import { BarcodeScanner } from "@/components/BarcodeScanner";

// ── Typy lokalne ──────────────────────────────────────────────
interface VehicleOption {
  reg: string;
  vehicle_type: string;
  brand: string | null;
}

interface TireDisplayData {
  tire: Tire | null;
  reading: TireReading | null;
  status: TireStatus;
  treadMin: number | null;
}

type Tab = "przeglad" | "inspekcja" | "historia" | "magazyn";

// ── Pusta forma inspekcji ─────────────────────────────────────
interface ReadingForm {
  [position: string]: {
    tread_outer_mm: string;
    tread_center_mm: string;
    tread_inner_mm: string;
    pressure_bar: string;
    damage_notes: string;
    action_needed: string;
  };
}

function emptyReadingForm(positions: TirePositionDef[]): ReadingForm {
  const f: ReadingForm = {};
  positions.forEach(p => {
    f[p.id] = {
      tread_outer_mm: "", tread_center_mm: "", tread_inner_mm: "",
      pressure_bar: "", damage_notes: "", action_needed: "ok",
    };
  });
  return f;
}

// ── Parsowanie kodu kreskowego opony ─────────────────────────
function parseTireBarcode(text: string): { brand?: string; size?: string; dot?: string; notes?: string } {
  const result: { brand?: string; size?: string; dot?: string; notes?: string } = {};

  // Rozmiar: "315/70R22.5", "31570R225", "315/70 R 22.5"
  const sizeMatch = text.match(/(\d{2,3})[/\\]?(\d{2,3})\s*[Rr]\s*(\d{2}(?:\.\d)?)/);
  if (sizeMatch) {
    result.size = `${sizeMatch[1]}/${sizeMatch[2]} R${sizeMatch[3]}`;
  }

  // DOT: opcjonalnie poprzedzony "DOT"
  const dotMatch = text.match(/(?:DOT[:\s]*)?([0-5]\d[0-9]\d)(?!\d)/);
  if (dotMatch) result.dot = dotMatch[1];

  // Znani producenci w tekście
  const brands = ["Michelin", "Pirelli", "Continental", "Bridgestone", "Goodyear",
    "Dunlop", "Hankook", "Yokohama", "Toyo", "Fulda", "Semperit", "Sava",
    "Debica", "Kormoran", "Uniroyal", "Nokian", "Cooper", "Firestone"];
  for (const b of brands) {
    if (text.toLowerCase().includes(b.toLowerCase())) { result.brand = b; break; }
  }

  result.notes = `Kod: ${text}`;
  return result;
}

// ══════════════════════════════════════════════════════════════
// SVG: Ciągnik 4×2 — widok z góry
// ══════════════════════════════════════════════════════════════
function TruckSVG({
  dataMap, selected, onTireClick,
}: {
  dataMap: Map<string, TireDisplayData>;
  selected: string | null;
  onTireClick: (id: string) => void;
}) {
  return (
    <svg viewBox="0 0 300 490" className="w-full" style={{ maxWidth: 270 }}>
      {/* ── Karoseria ciągnika ── */}
      {/* Przód/maska */}
      <polygon points="72,0 228,0 242,52 58,52" fill="#334155" />
      {/* Grill */}
      <rect x="90" y="4" width="120" height="44" rx="3" fill="#1e293b" />
      <line x1="110" y1="4" x2="110" y2="48" stroke="#475569" strokeWidth="1" />
      <line x1="130" y1="4" x2="130" y2="48" stroke="#475569" strokeWidth="1" />
      <line x1="150" y1="4" x2="150" y2="48" stroke="#475569" strokeWidth="1" />
      <line x1="170" y1="4" x2="170" y2="48" stroke="#475569" strokeWidth="1" />
      <line x1="190" y1="4" x2="190" y2="48" stroke="#475569" strokeWidth="1" />
      {/* Reflektory */}
      <rect x="60" y="6" width="24" height="14" rx="2" fill="#fef08a" opacity="0.8" />
      <rect x="216" y="6" width="24" height="14" rx="2" fill="#fef08a" opacity="0.8" />
      {/* Kabina */}
      <rect x="40" y="52" width="220" height="168" rx="2" fill="#475569" />
      {/* Szyba przednia */}
      <rect x="52" y="56" width="196" height="38" rx="2" fill="#93c5fd" opacity="0.45" />
      {/* Wnętrze kabiny */}
      <rect x="52" y="98" width="196" height="116" rx="1" fill="#334155" />
      {/* Fotel kierowcy */}
      <rect x="80" y="116" width="40" height="30" rx="4" fill="#475569" />
      {/* Deska rozdzielcza */}
      <rect x="54" y="100" width="192" height="12" fill="#1e293b" />
      {/* Lusterka */}
      <rect x="14" y="74" width="26" height="16" rx="3" fill="#64748b" />
      <rect x="260" y="74" width="26" height="16" rx="3" fill="#64748b" />
      {/* Stopnie wejściowe */}
      <rect x="40" y="210" width="15" height="22" rx="2" fill="#374151" />
      <rect x="245" y="210" width="15" height="22" rx="2" fill="#374151" />
      {/* Rama — szyny podłużne */}
      <rect x="92" y="220" width="18" height="240" fill="#374151" />
      <rect x="190" y="220" width="18" height="240" fill="#374151" />
      {/* Belki poprzeczne */}
      <rect x="110" y="246" width="80" height="7" fill="#4b5563" />
      <rect x="110" y="302" width="80" height="7" fill="#4b5563" />
      <rect x="110" y="358" width="80" height="7" fill="#4b5563" />
      {/* Koło pociągowe (5th wheel) */}
      <circle cx="150" cy="355" r="30" fill="#6b7280" stroke="#94a3b8" strokeWidth="1.5" />
      <circle cx="150" cy="355" r="18" fill="#4b5563" />
      <circle cx="150" cy="355" r="6"  fill="#374151" />
      {/* Tylny zderzak */}
      <rect x="68" y="460" width="164" height="10" rx="2" fill="#374151" />
      <rect x="55" y="468" width="190" height="8" rx="2" fill="#64748b" />

      {/* ── Oś 1: belka (widoczna po bokach kabiny) ── */}
      <line x1="40" y1="184" x2="10" y2="184" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />
      <line x1="260" y1="184" x2="290" y2="184" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />
      {/* ── Oś 2: belka ── */}
      <line x1="62" y1="427" x2="6" y2="427" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />
      <line x1="238" y1="427" x2="294" y2="427" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />

      {/* ── Opony ── */}
      {CIAGNIK_POSITIONS.map(pos => {
        const d = dataMap.get(pos.id);
        const status = d?.status ?? "no-data";
        const colors = STATUS_COLORS[status];
        const isSelected = selected === pos.id;
        const tread = d?.treadMin;

        return (
          <g key={pos.id} onClick={() => onTireClick(pos.id)} style={{ cursor: "pointer" }}>
            {/* Cień */}
            <rect
              x={pos.svgX + 2} y={pos.svgY + 3}
              width={pos.tireW} height={pos.tireH}
              rx={4} fill="rgba(0,0,0,0.35)"
            />
            {/* Opona */}
            <rect
              x={pos.svgX} y={pos.svgY}
              width={pos.tireW} height={pos.tireH}
              rx={4}
              fill={colors.fill}
              stroke={isSelected ? "#fff" : colors.stroke}
              strokeWidth={isSelected ? 2.5 : 1.5}
              opacity={0.95}
            />
            {/* Bieżnik — poziome prążki */}
            {[0.25, 0.5, 0.75].map((frac, i) => (
              <line
                key={i}
                x1={pos.svgX + 4} y1={pos.svgY + pos.tireH * frac}
                x2={pos.svgX + pos.tireW - 4} y2={pos.svgY + pos.tireH * frac}
                stroke="rgba(0,0,0,0.2)" strokeWidth={1}
              />
            ))}
            {/* Etykieta pozycji */}
            <text
              x={pos.svgX + pos.tireW / 2}
              y={pos.svgY + (tread != null ? pos.tireH * 0.38 : pos.tireH / 2 + 5)}
              textAnchor="middle" fill={colors.text}
              fontSize={pos.isTwin ? 8 : 9} fontWeight="700"
              fontFamily="system-ui, sans-serif"
            >
              {pos.label}
            </text>
            {/* Wartość bieżnika */}
            {tread != null && (
              <text
                x={pos.svgX + pos.tireW / 2}
                y={pos.svgY + pos.tireH * 0.65}
                textAnchor="middle" fill={colors.text}
                fontSize={pos.isTwin ? 9 : 10} fontWeight="bold"
                fontFamily="system-ui, sans-serif"
              >
                {tread.toFixed(1)}
              </text>
            )}
            {/* mm */}
            {tread != null && (
              <text
                x={pos.svgX + pos.tireW / 2}
                y={pos.svgY + pos.tireH * 0.80}
                textAnchor="middle" fill={colors.text}
                fontSize={7} opacity={0.75}
                fontFamily="system-ui, sans-serif"
              >
                mm
              </text>
            )}
            {/* Zaznaczenie */}
            {isSelected && (
              <rect
                x={pos.svgX - 2} y={pos.svgY - 2}
                width={pos.tireW + 4} height={pos.tireH + 4}
                rx={6} fill="none" stroke="#fff" strokeWidth={2}
                strokeDasharray="4 2"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ══════════════════════════════════════════════════════════════
// SVG: Naczepa 3-osiowa mega — widok z góry
// ══════════════════════════════════════════════════════════════
function TrailerSVG({
  dataMap, selected, onTireClick,
}: {
  dataMap: Map<string, TireDisplayData>;
  selected: string | null;
  onTireClick: (id: string) => void;
}) {
  return (
    <svg viewBox="0 0 300 490" className="w-full" style={{ maxWidth: 270 }}>
      {/* ── Nadwozie naczepy ── */}
      {/* Główne nadwozie */}
      <rect x="30" y="12" width="240" height="458" rx="4" fill="#475569" />
      {/* Wnętrze ładunkowe */}
      <rect x="40" y="22" width="220" height="438" rx="2" fill="#334155" />
      {/* Pintle / kingpin */}
      <circle cx="150" cy="52" r="20" fill="#6b7280" stroke="#94a3b8" strokeWidth="1.5" />
      <circle cx="150" cy="52" r="11" fill="#4b5563" />
      <circle cx="150" cy="52" r="4"  fill="#374151" />
      {/* Nogi podporowe (landing gear) */}
      <rect x="42" y="88" width="20" height="24" rx="2" fill="#64748b" />
      <rect x="238" y="88" width="20" height="24" rx="2" fill="#64748b" />
      <rect x="50" y="112" width="6" height="16" rx="1" fill="#94a3b8" />
      <rect x="244" y="112" width="6" height="16" rx="1" fill="#94a3b8" />
      {/* Oznaczenia boczne (paski odblaskowe) */}
      {[140, 200, 260, 320, 380].map(y => (
        <rect key={y} x="30" y={y} width="12" height="8" rx="1" fill="#fef08a" opacity="0.6" />
      ))}
      {[140, 200, 260, 320, 380].map(y => (
        <rect key={y} x="258" y={y} width="12" height="8" rx="1" fill="#fef08a" opacity="0.6" />
      ))}
      {/* Tylne światła */}
      <rect x="34" y="458" width="18" height="10" rx="2" fill="#ef4444" opacity="0.9" />
      <rect x="248" y="458" width="18" height="10" rx="2" fill="#ef4444" opacity="0.9" />
      <rect x="34" y="458" width="8" height="10" rx="2" fill="#fef08a" opacity="0.9" />
      <rect x="258" y="458" width="8" height="10" rx="2" fill="#fef08a" opacity="0.9" />

      {/* ── Belki osi ── */}
      {/* Oś 1 */}
      <line x1="62" y1="262" x2="6"   y2="262" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />
      <line x1="238" y1="262" x2="294" y2="262" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />
      {/* Oś 2 */}
      <line x1="62" y1="347" x2="6"   y2="347" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />
      <line x1="238" y1="347" x2="294" y2="347" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />
      {/* Oś 3 */}
      <line x1="62" y1="432" x2="6"   y2="432" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />
      <line x1="238" y1="432" x2="294" y2="432" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />

      {/* ── Opony ── */}
      {NACZEPA_POSITIONS.map(pos => {
        const d = dataMap.get(pos.id);
        const status = d?.status ?? "no-data";
        const colors = STATUS_COLORS[status];
        const isSelected = selected === pos.id;
        const tread = d?.treadMin;

        return (
          <g key={pos.id} onClick={() => onTireClick(pos.id)} style={{ cursor: "pointer" }}>
            <rect
              x={pos.svgX + 2} y={pos.svgY + 3}
              width={pos.tireW} height={pos.tireH}
              rx={4} fill="rgba(0,0,0,0.35)"
            />
            <rect
              x={pos.svgX} y={pos.svgY}
              width={pos.tireW} height={pos.tireH}
              rx={4}
              fill={colors.fill}
              stroke={isSelected ? "#fff" : pos.isSpare ? "#f59e0b" : colors.stroke}
              strokeWidth={isSelected ? 2.5 : pos.isSpare ? 2 : 1.5}
              strokeDasharray={!isSelected && pos.isSpare ? "3 2" : undefined}
              opacity={0.95}
            />
            {[0.25, 0.5, 0.75].map((frac, i) => (
              <line
                key={i}
                x1={pos.svgX + 4} y1={pos.svgY + pos.tireH * frac}
                x2={pos.svgX + pos.tireW - 4} y2={pos.svgY + pos.tireH * frac}
                stroke="rgba(0,0,0,0.2)" strokeWidth={1}
              />
            ))}
            <text
              x={pos.svgX + pos.tireW / 2}
              y={pos.svgY + (tread != null ? pos.tireH * 0.38 : pos.tireH / 2 + 5)}
              textAnchor="middle" fill={colors.text}
              fontSize={8} fontWeight="700"
              fontFamily="system-ui, sans-serif"
            >
              {pos.label}
            </text>
            {tread != null && (
              <>
                <text
                  x={pos.svgX + pos.tireW / 2}
                  y={pos.svgY + pos.tireH * 0.65}
                  textAnchor="middle" fill={colors.text}
                  fontSize={9} fontWeight="bold"
                  fontFamily="system-ui, sans-serif"
                >
                  {tread.toFixed(1)}
                </text>
                <text
                  x={pos.svgX + pos.tireW / 2}
                  y={pos.svgY + pos.tireH * 0.80}
                  textAnchor="middle" fill={colors.text}
                  fontSize={7} opacity={0.75}
                  fontFamily="system-ui, sans-serif"
                >
                  mm
                </text>
              </>
            )}
            {isSelected && (
              <rect
                x={pos.svgX - 2} y={pos.svgY - 2}
                width={pos.tireW + 4} height={pos.tireH + 4}
                rx={6} fill="none" stroke="#fff" strokeWidth={2}
                strokeDasharray="4 2"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ══════════════════════════════════════════════════════════════
// Panel szczegółów wybranej opony (z formularzem montażu/edycji)
// ══════════════════════════════════════════════════════════════
function TireDetailPanel({
  positionId,
  vehicleReg,
  data,
  onClose,
  onReload,
}: {
  positionId: string;
  vehicleReg: string;
  data: TireDisplayData;
  onClose: () => void;
  onReload: () => void;
}) {
  const { tire, reading, status, treadMin } = data;
  const colors = STATUS_COLORS[status];
  const ageYrs = tire?.dot ? dotAgeYears(tire.dot) : null;

  const allPositions = [...CIAGNIK_POSITIONS, ...NACZEPA_POSITIONS];
  const posDef = allPositions.find(p => p.id === positionId);

  // Tryb edycji — domyślnie włączony gdy brak opony
  const [editMode, setEditMode] = useState(!tire);
  const [form, setForm] = useState({
    brand: "", model: "", size: "", dot: "",
    installed_date: new Date().toISOString().slice(0, 10),
    installed_km: "", is_retreaded: false, notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Magazyn — wybór opony do przypisania
  const [showWarehouse, setShowWarehouse] = useState(false);
  const [warehouseItems, setWarehouseItems] = useState<TireWarehouseItem[]>([]);
  const [warehouseLoading, setWarehouseLoading] = useState(false);
  const [fromWarehouseId, setFromWarehouseId] = useState<string | null>(null);

  // Skaner kodów kreskowych
  const [showScanner, setShowScanner] = useState(false);

  // Zdejmowanie opony (→ magazyn używanych lub złom)
  const [dismountMode, setDismountMode] = useState(false);
  const [dismountReason, setDismountReason] = useState<RemovalReason | "">("");
  const [dismountKm, setDismountKm] = useState("");
  const [dismountToWarehouse, setDismountToWarehouse] = useState(true);
  const [dismounting, setDismounting] = useState(false);
  const [dismountMsg, setDismountMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!dismountReason) return;
    const suggestion = suggestDismountFate(treadMin, dismountReason);
    setDismountToWarehouse(suggestion.toWarehouse);
  }, [dismountReason, treadMin]);

  async function handleDismount() {
    if (!tire || !dismountReason) { setDismountMsg("Wybierz powód zdjęcia"); return; }
    setDismounting(true); setDismountMsg(null);
    try {
      const purpose: TirePurpose = dismountToWarehouse ? "montaz" : "zlom";
      const { error: insErr } = await supabase.from("tire_warehouse").insert({
        brand: tire.brand || "Nieznana",
        model: tire.model,
        size: tire.size || "",
        dot: tire.dot,
        condition: "uzywana",
        tread_mm: treadMin,
        quantity: 1,
        location: null,
        price_pln: null,
        notes: `Zdjęta z ${vehicleReg} / ${positionId}${dismountKm ? `, ${dismountKm} km` : ""}`,
        source: "zdjęcie",
        source_vehicle_reg: vehicleReg,
        source_position: positionId,
        removed_reason: dismountReason,
        removed_km: dismountKm ? parseInt(dismountKm) : null,
        purpose,
        is_scrap: !dismountToWarehouse,
      });
      if (insErr) throw insErr;

      const { error: delErr } = await supabase
        .from("tires")
        .delete()
        .eq("vehicle_reg", vehicleReg)
        .eq("position", positionId);
      if (delErr) throw delErr;

      setDismountMode(false);
      setDismountReason("");
      setDismountKm("");
      onReload();
    } catch (err: unknown) {
      setDismountMsg(`Błąd: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDismounting(false);
    }
  }

  function handleBarcodeResult(text: string) {
    const parsed = parseTireBarcode(text);
    setForm(f => ({
      ...f,
      brand:  parsed.brand  || f.brand,
      size:   parsed.size   || f.size,
      dot:    parsed.dot    || f.dot,
      notes:  parsed.notes  ? (f.notes ? `${f.notes}; ${parsed.notes}` : parsed.notes) : f.notes,
    }));
    setShowScanner(false);
  }

  async function loadWarehouse() {
    setWarehouseLoading(true);
    const { data } = await supabase
      .from("tire_warehouse")
      .select("*")
      .gt("quantity", 0)
      .eq("is_scrap", false)
      .order("brand");
    setWarehouseItems(data ?? []);
    setWarehouseLoading(false);
    setShowWarehouse(true);
  }

  function pickFromWarehouse(w: TireWarehouseItem) {
    setForm((f) => ({
      ...f,
      brand: w.brand,
      model: w.model ?? "",
      size: w.size,
      dot: w.dot ?? "",
    }));
    setFromWarehouseId(w.id);
    setShowWarehouse(false);
  }

  // Wypełnij formularz istniejącymi danymi przy edycji
  useEffect(() => {
    if (tire) {
      setForm({
        brand:          tire.brand          ?? "",
        model:          tire.model          ?? "",
        size:           tire.size           ?? "",
        dot:            tire.dot            ?? "",
        installed_date: tire.installed_date ?? new Date().toISOString().slice(0, 10),
        installed_km:   tire.installed_km   != null ? String(tire.installed_km) : "",
        is_retreaded:   tire.is_retreaded,
        notes:          tire.notes          ?? "",
      });
    }
  }, [tire]);

  // Reset trybu edycji gdy zmienia się pozycja
  useEffect(() => {
    setEditMode(!tire);
    setMsg(null);
    setShowWarehouse(false);
    setFromWarehouseId(null);
    setDismountMode(false);
    setDismountReason("");
    setDismountKm("");
    setDismountMsg(null);
  }, [positionId, vehicleReg]);

  async function handleSaveTire() {
    if (!form.brand || !form.size) { setMsg("Marka i rozmiar są wymagane"); return; }
    setSaving(true); setMsg(null);
    try {
      const payload = {
        vehicle_reg:    vehicleReg,
        position:       positionId,
        brand:          form.brand,
        model:          form.model          || null,
        size:           form.size,
        dot:            form.dot            || null,
        installed_date: form.installed_date || null,
        installed_km:   form.installed_km   ? parseInt(form.installed_km) : null,
        is_retreaded:   form.is_retreaded,
        status:         "active" as const,
        notes:          form.notes          || null,
      };
      const { error } = await supabase
        .from("tires")
        .upsert(payload, { onConflict: "vehicle_reg,position" });
      if (error) throw error;

      // Jeśli opona pochodzi z magazynu — zmniejsz ilość
      if (fromWarehouseId) {
        const warehouseItem = warehouseItems.find((w) => w.id === fromWarehouseId);
        if (warehouseItem) {
          if (warehouseItem.quantity <= 1) {
            await supabase.from("tire_warehouse").delete().eq("id", fromWarehouseId);
          } else {
            await supabase
              .from("tire_warehouse")
              .update({ quantity: warehouseItem.quantity - 1 })
              .eq("id", fromWarehouseId);
          }
          setFromWarehouseId(null);
        }
      }

      setMsg("✓ Zapisano");
      setEditMode(false);
      onReload();
    } catch (err: unknown) {
      setMsg(`Błąd: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  function field(label: string, key: keyof typeof form, type = "text", ph = "") {
    return (
      <div>
        <label className="block text-xs text-slate-400 mb-1">{label}</label>
        <input
          type={type}
          value={String(form[key])}
          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
          placeholder={ph}
          className="w-full bg-slate-600 border border-slate-500 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
    );
  }

  return (
    <div className="bg-slate-800 border border-slate-600 rounded-xl p-4 h-full">
      {/* Nagłówek */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm ${colors.bg}`}>
            {posDef?.label ?? positionId}
          </div>
          <div>
            <div className="text-white font-semibold text-sm">{vehicleReg}</div>
            <span className={`text-xs px-2 py-0.5 rounded font-medium ${colors.bg} text-white`}>
              {colors.label}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tire && !editMode && !dismountMode && (
            <button
              onClick={() => { setEditMode(true); setMsg(null); }}
              className="text-xs text-slate-400 hover:text-blue-400 px-2 py-1 rounded hover:bg-slate-700 transition-colors"
            >
              ✏️ Edytuj
            </button>
          )}
          {tire && !editMode && !dismountMode && (
            <button
              onClick={() => { setDismountMode(true); setDismountMsg(null); }}
              className="text-xs text-slate-400 hover:text-red-400 px-2 py-1 rounded hover:bg-slate-700 transition-colors"
            >
              🔧 Zdejmij
            </button>
          )}
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded">✕</button>
        </div>
      </div>

      {/* ── Formularz montażu / edycji ── */}
      {editMode ? (
        <div className="space-y-3 text-sm">
          <div className="text-slate-300 text-xs font-semibold uppercase tracking-wide mb-1">
            {tire ? "Edytuj dane opony" : "Przypisz oponę do pozycji"}
          </div>

          {/* ── Ostrzeżenie: są pomiary, ale brak zarejestrowanej opony ── */}
          {!tire && reading && (
            <div className="bg-amber-900/30 border border-amber-700/50 rounded-lg p-2.5 text-xs text-amber-300">
              ⚠ Ta pozycja ma zapisaną inspekcję
              {treadMin != null && <> (bieżnik: <strong>{treadMin.toFixed(1)} mm</strong>{status !== "no-data" && `, ${STATUS_COLORS[status].label}`})</>}
              , ale nie ma zarejestrowanej opony. Uzupełnij dane poniżej, żeby powiązać je z tą pozycją — dopiero wtedy pojawią się opcje Edytuj/Zdejmij.
            </div>
          )}

          {/* ── Przypisz z magazynu (tylko gdy brak opony) ── */}
          {!tire && (
            <div className="mb-2">
              <div className="flex items-center gap-2 mb-1">
                <button
                  onClick={loadWarehouse}
                  disabled={warehouseLoading}
                  className="text-xs px-3 py-1.5 rounded-lg border border-blue-500 text-blue-400 hover:bg-blue-600 hover:text-white hover:border-blue-600 transition-colors disabled:opacity-50"
                >
                  📦 {warehouseLoading ? "Ładuję..." : "Wybierz z magazynu"}
                </button>
                {fromWarehouseId && (
                  <span className="text-xs text-green-400 font-medium">✓ Dane z magazynu</span>
                )}
              </div>
              {showWarehouse && (
                <div className="bg-slate-900 border border-slate-600 rounded-lg overflow-hidden mb-2 max-h-44 overflow-y-auto">
                  <div className="sticky top-0 bg-slate-900 text-xs text-slate-400 px-2 py-1.5 border-b border-slate-700 font-semibold flex justify-between">
                    <span>Magazyn opon</span>
                    <button onClick={() => setShowWarehouse(false)} className="text-slate-500 hover:text-white">✕</button>
                  </div>
                  {warehouseItems.length === 0 ? (
                    <div className="text-xs text-slate-500 text-center py-3">Magazyn pusty</div>
                  ) : (
                    warehouseItems.map((w) => (
                      <button
                        key={w.id}
                        onClick={() => pickFromWarehouse(w)}
                        className="w-full text-left px-3 py-2 hover:bg-slate-700 border-b border-slate-800 last:border-0 transition-colors"
                      >
                        <div className="text-white text-xs font-medium">
                          {w.brand}{w.model ? ` ${w.model}` : ""}
                        </div>
                        <div className="text-slate-400 text-xs">
                          {w.size}
                          {w.dot ? ` · DOT ${w.dot}` : ""}
                          {" · "}{w.condition}
                          {w.tread_mm != null ? ` · ${w.tread_mm} mm` : ""}
                          {" · "}<span className="text-slate-300 font-medium">{w.quantity} szt.</span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {/* Skaner kodów kreskowych */}
          <button
            type="button"
            onClick={() => setShowScanner(true)}
            className="w-full flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg border border-dashed border-yellow-600/60 text-yellow-400 hover:bg-yellow-700/20 text-xs font-medium transition-colors"
          >
            📷 Skanuj kod kreskowy opony (kamera)
          </button>

          <div className="grid grid-cols-2 gap-2">
            {field("Marka *",  "brand",  "text", "np. Michelin")}
            {field("Model",    "model",  "text", "np. X MultiWay")}
          </div>
          {field("Rozmiar *", "size", "text", "315/70 R22.5")}
          <div className="grid grid-cols-2 gap-2">
            {field("DOT (WWRR)", "dot", "text", "np. 1524")}
            {field(posDef?.isSpare ? "Data założenia" : "Data montażu", "installed_date", "date")}
          </div>
          {!posDef?.isSpare && field("Stan km przy montażu", "installed_km", "number", "np. 450000")}
          {field("Uwagi", "notes", "text", "np. bieżnikowana Bandag")}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.is_retreaded}
              onChange={e => setForm(f => ({ ...f, is_retreaded: e.target.checked }))}
              className="w-4 h-4 rounded accent-blue-500"
            />
            <span className="text-slate-300 text-sm">Opona bieżnikowana</span>
          </label>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleSaveTire}
              disabled={saving || !form.brand || !form.size}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors"
            >
              {saving ? "Zapisuję..." : "Zapisz"}
            </button>
            {tire && (
              <button
                onClick={() => { setEditMode(false); setMsg(null); }}
                className="text-slate-400 hover:text-white text-sm px-3 py-1.5 rounded"
              >
                Anuluj
              </button>
            )}
            {msg && (
              <span className={`text-xs ${msg.startsWith("✓") ? "text-green-400" : "text-red-400"}`}>{msg}</span>
            )}
          </div>
        </div>
      ) : tire ? (
        /* ── Widok danych ── */
        <div className="space-y-3 text-sm">
          <div className="bg-slate-700/50 rounded-lg p-3 space-y-1.5">
            <div className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-2">Opona</div>
            <Row label="Marka / model" value={[tire.brand, tire.model].filter(Boolean).join(" ") || "—"} />
            <Row label="Rozmiar" value={tire.size ?? "—"} />
            <Row label="DOT" value={tire.dot ? `${tire.dot} (${parseDOT(tire.dot)})` : "—"} />
            {ageYrs != null && (
              <Row
                label="Wiek"
                value={`${ageYrs.toFixed(1)} lat`}
                valueClass={ageYrs > 6 ? "text-red-400" : ageYrs > 4 ? "text-amber-400" : "text-green-400"}
              />
            )}
            <Row label="Bieżnikowana" value={tire.is_retreaded ? "Tak" : "Nie"} />
            {tire.installed_date && (
              <Row label={posDef?.isSpare ? "Założona do uchwytu" : "Zamontowana"} value={tire.installed_date} />
            )}
            {tire.installed_km != null && !posDef?.isSpare && (
              <Row label="Stan km montażu" value={`${tire.installed_km.toLocaleString("pl-PL")} km`} />
            )}
            {posDef?.isSpare && (
              <Row label="Uwaga" value="Opona zapasowa — sprawdzaj ciśnienie i wiek DOT cyklicznie" valueClass="text-amber-400" />
            )}
            {tire.notes && <Row label="Uwagi" value={tire.notes} />}
          </div>

          {reading ? (
            <div className="bg-slate-700/50 rounded-lg p-3 space-y-1.5">
              <div className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-2">Ostatnia inspekcja</div>
              <Row label="Data" value={new Date(reading.created_at).toLocaleDateString("pl-PL")} />
              {reading.tread_outer_mm != null && (
                <Row label="Bieżnik (Z/Ś/W)" value={
                  `${reading.tread_outer_mm ?? "—"} / ${reading.tread_center_mm ?? "—"} / ${reading.tread_inner_mm ?? "—"} mm`
                } />
              )}
              {treadMin != null && (
                <Row
                  label="Min bieżnik"
                  value={`${treadMin.toFixed(1)} mm`}
                  valueClass={treadMin < 2 ? "text-red-400 font-bold" : treadMin < 4 ? "text-amber-400 font-semibold" : "text-green-400"}
                />
              )}
              {reading.pressure_bar != null && (
                <Row
                  label="Ciśnienie"
                  value={`${reading.pressure_bar} bar`}
                  valueClass={
                    Math.abs(reading.pressure_bar - 8.5) / 8.5 > 0.20 ? "text-red-400 font-bold" :
                    Math.abs(reading.pressure_bar - 8.5) / 8.5 > 0.10 ? "text-amber-400" : "text-green-400"
                  }
                />
              )}
              {reading.damage_notes && <Row label="Uwagi" value={reading.damage_notes} />}
              {reading.action_needed && reading.action_needed !== "ok" && (
                <Row label="Zalecenie" value={reading.action_needed.toUpperCase()} valueClass="text-amber-400 font-semibold" />
              )}
            </div>
          ) : (
            <div className="bg-slate-700/30 rounded-lg p-3 text-slate-500 text-sm text-center">
              Brak pomiarów — dodaj inspekcję
            </div>
          )}

          {dismountMode && (
            <div className="bg-slate-700/50 rounded-lg p-3 space-y-3 border border-red-800/40">
              <div className="text-slate-300 text-xs font-semibold uppercase tracking-wide">
                Zdejmij oponę z pojazdu
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Powód zdjęcia *</label>
                <select
                  value={dismountReason}
                  onChange={(e) => setDismountReason(e.target.value as RemovalReason)}
                  className="w-full bg-slate-600 border border-slate-500 rounded px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
                >
                  <option value="">— wybierz —</option>
                  {REMOVAL_REASONS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Przebieg zdjęcia [km] (opcjonalnie)</label>
                <input
                  type="number"
                  value={dismountKm}
                  onChange={(e) => setDismountKm(e.target.value)}
                  placeholder="np. 512000"
                  className="w-full bg-slate-600 border border-slate-500 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              {dismountReason && (
                <label className="flex items-center gap-2 text-sm text-slate-200 bg-slate-800/60 rounded-lg p-2.5">
                  <input
                    type="checkbox"
                    checked={dismountToWarehouse}
                    onChange={(e) => setDismountToWarehouse(e.target.checked)}
                    className="w-4 h-4"
                  />
                  <span>
                    {dismountToWarehouse
                      ? "Nadaje się do ponownego montażu → trafi do magazynu jako używana"
                      : "Nie nadaje się do montażu → zostanie oznaczona jako złom"}
                    {treadMin != null && (
                      <span className="text-slate-400"> (bieżnik: {treadMin.toFixed(1)} mm)</span>
                    )}
                  </span>
                </label>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleDismount}
                  disabled={dismounting || !dismountReason}
                  className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors"
                >
                  {dismounting ? "Zapisuję..." : "Potwierdź zdjęcie"}
                </button>
                <button
                  onClick={() => { setDismountMode(false); setDismountReason(""); setDismountMsg(null); }}
                  className="text-slate-400 hover:text-white text-sm px-3 py-1.5 rounded"
                >
                  Anuluj
                </button>
                {dismountMsg && <span className="text-xs text-red-400">{dismountMsg}</span>}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* Skaner kodów kreskowych — pełnoekranowy modal */}
      {showScanner && (
        <BarcodeScanner
          onResult={handleBarcodeResult}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
}

function Row({ label, value, valueClass = "text-slate-200" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-400 shrink-0">{label}</span>
      <span className={`text-right ${valueClass}`}>{value}</span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Legenda statusów
// ══════════════════════════════════════════════════════════════
function StatusLegend() {
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {(["ok", "warning", "critical", "no-data"] as const).map(s => (
        <div key={s} className="flex items-center gap-1.5 text-xs text-slate-300">
          <div className="w-3 h-4 rounded-sm" style={{ background: STATUS_COLORS[s].fill }} />
          {STATUS_COLORS[s].label}
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Formularz nowej inspekcji
// ══════════════════════════════════════════════════════════════
function InspectionForm({
  vehicles,
  onSaved,
}: {
  vehicles: VehicleOption[];
  onSaved: () => void;
}) {
  const [vehicleReg, setVehicleReg] = useState("");
  const [inspectorName, setInspectorName] = useState("");
  const [inspDate, setInspDate] = useState(new Date().toISOString().slice(0, 10));
  const [odometerKm, setOdometerKm] = useState("");
  const [notes, setNotes] = useState("");
  const [readings, setReadings] = useState<ReadingForm>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const isCiagnik = vehicles.find(v => v.reg === vehicleReg)?.vehicle_type === "ciągnik";
  const positions = isCiagnik ? CIAGNIK_POSITIONS : NACZEPA_POSITIONS;

  useEffect(() => {
    if (vehicleReg) setReadings(emptyReadingForm(positions));
  }, [vehicleReg]);

  function updateReading(posId: string, field: string, value: string) {
    setReadings(prev => ({
      ...prev,
      [posId]: { ...prev[posId], [field]: value },
    }));
  }

  async function handleSave() {
    if (!vehicleReg) { setMsg("Wybierz pojazd"); return; }
    if (!inspectorName.trim()) { setMsg("Podaj osobę wykonującą przegląd"); return; }
    if (!odometerKm) { setMsg("Podaj stan licznika"); return; }
    setSaving(true); setMsg(null);
    try {
      const { data: insp, error: e1 } = await supabase
        .from("tire_inspections")
        .insert({
          vehicle_reg: vehicleReg,
          inspection_date: inspDate,
          inspector_name: inspectorName || null,
          odometer_km: odometerKm ? parseInt(odometerKm) : null,
          notes: notes || null,
        })
        .select("id")
        .single();
      if (e1 || !insp) throw e1 ?? new Error("brak id");

      const rows = positions
        .filter(p => {
          const r = readings[p.id];
          return r && (r.tread_outer_mm || r.tread_center_mm || r.tread_inner_mm || r.pressure_bar);
        })
        .map(p => {
          const r = readings[p.id];
          return {
            inspection_id: insp.id,
            vehicle_reg: vehicleReg,
            position: p.id,
            tread_outer_mm:  r.tread_outer_mm  ? parseFloat(r.tread_outer_mm)  : null,
            tread_center_mm: r.tread_center_mm ? parseFloat(r.tread_center_mm) : null,
            tread_inner_mm:  r.tread_inner_mm  ? parseFloat(r.tread_inner_mm)  : null,
            pressure_bar:    r.pressure_bar     ? parseFloat(r.pressure_bar)    : null,
            damage_notes:    r.damage_notes || null,
            action_needed:   r.action_needed   || "ok",
          };
        });

      if (rows.length > 0) {
        const { error: e2 } = await supabase.from("tire_readings").insert(rows);
        if (e2) throw e2;
      }
      setMsg(`✓ Inspekcja zapisana (${rows.length} odczytów)`);
      onSaved();
    } catch (err: unknown) {
      setMsg(`Błąd: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Nagłówek */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Pojazd *</label>
          <select
            value={vehicleReg}
            onChange={e => setVehicleReg(e.target.value)}
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="">— wybierz —</option>
            {vehicles.map(v => (
              <option key={v.reg} value={v.reg}>
                {v.reg} ({v.vehicle_type})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Data inspekcji</label>
          <input type="date" value={inspDate} onChange={e => setInspDate(e.target.value)}
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white" />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Inspektor *</label>
          <input type="text" value={inspectorName} onChange={e => setInspectorName(e.target.value)}
            placeholder="Imię i nazwisko"
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500" />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Stan km *</label>
          <input type="number" value={odometerKm} onChange={e => setOdometerKm(e.target.value)}
            placeholder="np. 450000"
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500" />
        </div>
      </div>

      {/* Tabela pomiarów */}
      {vehicleReg && positions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700">
                <th className="py-2 pr-3 font-medium">Pozycja</th>
                <th className="py-2 pr-2 font-medium">Bieżnik Z [mm]</th>
                <th className="py-2 pr-2 font-medium">Bieżnik Ś [mm]</th>
                <th className="py-2 pr-2 font-medium">Bieżnik W [mm]</th>
                <th className="py-2 pr-2 font-medium">Ciśnienie [bar]</th>
                <th className="py-2 pr-2 font-medium">Zalecenie</th>
                <th className="py-2 font-medium">Uwagi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {positions.map(pos => {
                const r = readings[pos.id] ?? { tread_outer_mm: "", tread_center_mm: "", tread_inner_mm: "", pressure_bar: "", damage_notes: "", action_needed: "ok" };
                const axleHeader = pos.axle !== positions[positions.indexOf(pos) - 1]?.axle;
                return (
                  <>
                    {axleHeader && (
                      <tr key={`h-${pos.axle}`} className="bg-slate-700/20">
                        <td colSpan={7} className="py-1 px-2 text-xs text-slate-400 font-semibold">
                          {axleLabel(pos.axle, isCiagnik ? "ciagnik" : "naczepa")}
                        </td>
                      </tr>
                    )}
                    <tr key={pos.id} className="hover:bg-slate-700/20">
                      <td className="py-2 pr-3">
                        <span className="font-mono font-semibold text-slate-200">{pos.label}</span>
                        <span className="ml-1 text-slate-500 text-xs">({pos.side === "L" ? "Lewa" : "Prawa"}{pos.twin ? ` ${pos.twin === "Z" ? "zewn." : "wewn."}` : ""})</span>
                      </td>
                      {(["tread_outer_mm", "tread_center_mm", "tread_inner_mm"] as const).map(field => (
                        <td key={field} className="py-1 pr-2">
                          <input type="number" step="0.1" min="0" max="20"
                            value={r[field]}
                            onChange={e => updateReading(pos.id, field, e.target.value)}
                            placeholder="—"
                            className="w-20 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-white placeholder-slate-600 focus:border-blue-500 focus:outline-none"
                          />
                        </td>
                      ))}
                      <td className="py-1 pr-2">
                        <input type="number" step="0.1" min="0" max="15"
                          value={r.pressure_bar}
                          onChange={e => updateReading(pos.id, "pressure_bar", e.target.value)}
                          placeholder="8.5"
                          className="w-20 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-white placeholder-slate-600 focus:border-blue-500 focus:outline-none"
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <select
                          value={r.action_needed}
                          onChange={e => updateReading(pos.id, "action_needed", e.target.value)}
                          className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-white focus:border-blue-500 focus:outline-none"
                        >
                          <option value="ok">OK</option>
                          <option value="monitor">Obserwuj</option>
                          <option value="rotate">Rotacja</option>
                          <option value="repair">Naprawa</option>
                          <option value="replace">Wymiana</option>
                        </select>
                      </td>
                      <td className="py-1">
                        <input type="text"
                          value={r.damage_notes}
                          onChange={e => updateReading(pos.id, "damage_notes", e.target.value)}
                          placeholder="np. pęknięcie boczne"
                          className="w-full min-w-[140px] bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-white placeholder-slate-600 focus:border-blue-500 focus:outline-none"
                        />
                      </td>
                    </tr>
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <label className="block text-xs text-slate-400 mb-1">Notatki do inspekcji</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Ogólne uwagi..."
          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 resize-none" />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !vehicleReg}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-5 py-2 rounded-lg text-sm transition-colors"
        >
          {saving ? "Zapisuję..." : "Zapisz inspekcję"}
        </button>
        {msg && (
          <span className={`text-sm ${msg.startsWith("✓") ? "text-green-400" : "text-red-400"}`}>{msg}</span>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Zakładka Historia inspekcji
// ══════════════════════════════════════════════════════════════
function HistoryTab({ vehicles }: { vehicles: VehicleOption[] }) {
  const [vehicleReg, setVehicleReg] = useState("");
  const [inspections, setInspections] = useState<TireInspection[]>([]);
  const [readings, setReadings] = useState<TireReading[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(reg: string) {
    setLoading(true);
    // Bez wybranego pojazdu → ostatnie inspekcje całej floty
    let query = supabase
      .from("tire_inspections")
      .select("*")
      .order("inspection_date", { ascending: false })
      .limit(50);
    if (reg) query = query.eq("vehicle_reg", reg);
    const { data: ins } = await query;
    setInspections(ins ?? []);
    if (ins && ins.length > 0) {
      const ids = ins.map((i: TireInspection) => i.id);
      const { data: rds } = await supabase
        .from("tire_readings")
        .select("*")
        .in("inspection_id", ids);
      setReadings(rds ?? []);
    } else {
      setReadings([]);
    }
    setLoading(false);
  }

  useEffect(() => { load(vehicleReg); }, [vehicleReg]);

  const allPositions = [...CIAGNIK_POSITIONS, ...NACZEPA_POSITIONS];

  return (
    <div className="space-y-4">
      <div className="w-64">
        <label className="block text-xs text-slate-400 mb-1">Pojazd (filtr opcjonalny)</label>
        <select value={vehicleReg} onChange={e => setVehicleReg(e.target.value)}
          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white">
          <option value="">— wszystkie pojazdy —</option>
          {vehicles.map(v => <option key={v.reg} value={v.reg}>{v.reg} ({v.vehicle_type})</option>)}
        </select>
      </div>

      {loading && <div className="text-slate-400 text-sm">Ładowanie...</div>}
      {!loading && inspections.length === 0 && (
        <div className="text-slate-500 text-sm">
          {vehicleReg ? "Brak inspekcji dla tego pojazdu" : "Brak zapisanych inspekcji"}
        </div>
      )}

      <div className="space-y-2">
        {inspections.map(ins => {
          const insReadings = readings.filter(r => r.inspection_id === ins.id);
          const isOpen = expanded === ins.id;
          return (
            <div key={ins.id} className="bg-slate-700/40 rounded-lg border border-slate-600/50">
              <button
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-700/60 rounded-lg transition-colors"
                onClick={() => setExpanded(isOpen ? null : ins.id)}
              >
                <div className="flex items-center gap-4">
                  <span className="text-white font-semibold">{ins.inspection_date}</span>
                  <span className="font-mono text-xs font-semibold text-blue-300 bg-blue-900/40 px-2 py-0.5 rounded">
                    {ins.vehicle_reg}
                  </span>
                  {ins.inspector_name && <span className="text-slate-400 text-sm">{ins.inspector_name}</span>}
                  {ins.odometer_km && <span className="text-slate-400 text-sm">{ins.odometer_km.toLocaleString("pl-PL")} km</span>}
                  <span className="text-xs text-slate-500">{insReadings.length} pomiarów</span>
                </div>
                <span className="text-slate-400">{isOpen ? "▲" : "▼"}</span>
              </button>
              {isOpen && insReadings.length > 0 && (
                <div className="px-4 pb-4">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-700">
                          <th className="pb-1 text-left">Pozycja</th>
                          <th className="pb-1">Bieżnik Z</th>
                          <th className="pb-1">Bieżnik Ś</th>
                          <th className="pb-1">Bieżnik W</th>
                          <th className="pb-1">Min</th>
                          <th className="pb-1">Ciśnienie</th>
                          <th className="pb-1">Zalecenie</th>
                          <th className="pb-1 text-left">Uwagi</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700/30">
                        {insReadings.map(r => {
                          const posLabel = allPositions.find(p => p.id === r.position)?.label ?? r.position;
                          const mn = minTread(r);
                          const status = calcTireStatus({ treadMm: mn, pressureBar: r.pressure_bar });
                          const c = STATUS_COLORS[status];
                          return (
                            <tr key={r.id} className="hover:bg-slate-700/20">
                              <td className="py-1 pr-3 font-mono font-semibold text-slate-200">{posLabel}</td>
                              <td className="py-1 text-center text-slate-300">{r.tread_outer_mm ?? "—"}</td>
                              <td className="py-1 text-center text-slate-300">{r.tread_center_mm ?? "—"}</td>
                              <td className="py-1 text-center text-slate-300">{r.tread_inner_mm ?? "—"}</td>
                              <td className="py-1 text-center font-bold" style={{ color: c.fill }}>
                                {mn != null ? mn.toFixed(1) : "—"}
                              </td>
                              <td className="py-1 text-center text-slate-300">{r.pressure_bar ?? "—"}</td>
                              <td className="py-1 text-center">
                                <span className={`px-1.5 py-0.5 rounded text-white text-xs ${r.action_needed === "replace" ? "bg-red-700" : r.action_needed === "repair" ? "bg-amber-600" : "bg-slate-600"}`}>
                                  {r.action_needed ?? "ok"}
                                </span>
                              </td>
                              <td className="py-1 text-slate-400">{r.damage_notes ?? ""}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {ins.notes && <div className="mt-2 text-xs text-slate-400 bg-slate-700/30 rounded p-2">{ins.notes}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Zakładka Magazyn
// ══════════════════════════════════════════════════════════════
function WarehouseTab() {
  const [items, setItems] = useState<TireWarehouseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ brand: "", model: "", size: "", dot: "", condition: "nowa", purpose: "montaz" as TirePurpose, tread_mm: "", quantity: "1", location: "", price_pln: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

  function handleBarcodeResult(text: string) {
    const parsed = parseTireBarcode(text);
    setForm(f => ({
      ...f,
      brand:  parsed.brand  || f.brand,
      size:   parsed.size   || f.size,
      dot:    parsed.dot    || f.dot,
      notes:  parsed.notes  ? (f.notes ? `${f.notes}; ${parsed.notes}` : parsed.notes) : f.notes,
    }));
    setShowScanner(false);
    setShowAdd(true);
  }

  async function load() {
    setLoading(true);
    const { data } = await supabase.from("tire_warehouse").select("*").order("created_at", { ascending: false });
    setItems(data ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleAdd() {
    // Rozmiar i ilość wystarczą — marka bywa nieznana dla opon zastanych na placu
    if (!form.size) return;
    setSaving(true);
    await supabase.from("tire_warehouse").insert({
      brand: form.brand || "Nieznana", model: form.model || null, size: form.size,
      dot: form.dot || null, condition: form.condition,
      tread_mm: form.tread_mm ? parseFloat(form.tread_mm) : null,
      quantity: parseInt(form.quantity) || 1,
      location: form.location || null,
      price_pln: form.price_pln ? parseFloat(form.price_pln) : null,
      notes: form.notes || null,
      source: "plac",
      purpose: form.purpose,
      is_scrap: form.purpose === "zlom",
    });
    setSaving(false);
    setShowAdd(false);
    setForm({ brand: "", model: "", size: "", dot: "", condition: "nowa", purpose: "montaz", tread_mm: "", quantity: "1", location: "", price_pln: "", notes: "" });
    load();
  }

  async function handleDelete(id: string) {
    if (!confirm("Usuń tę oponę z magazynu?")) return;
    await supabase.from("tire_warehouse").delete().eq("id", id);
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-slate-400 text-sm">
          {items.filter(i => !i.is_scrap).reduce((s, i) => s + i.quantity, 0)} opon dostępnych
          {items.some(i => i.is_scrap) && (
            <span className="text-red-400">
              {" "}· {items.filter(i => i.is_scrap).reduce((s, i) => s + i.quantity, 0)} na złom
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowScanner(true)}
            className="border border-yellow-600/60 text-yellow-400 hover:bg-yellow-700/20 text-sm font-medium px-3 py-2 rounded-lg transition-colors"
            title="Skanuj kod kreskowy opony"
          >
            📷 Skanuj
          </button>
          <button onClick={() => setShowAdd(!showAdd)}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
            + Dodaj oponę
          </button>
        </div>
      </div>

      {showAdd && (
        <div className="bg-slate-700/40 rounded-xl border border-slate-600/50 p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            {[
              { label: "Marka", key: "brand", ph: "np. Michelin (jeśli nieznana — zostaw puste)" },
              { label: "Model", key: "model", ph: "np. X MultiWay" },
              { label: "Rozmiar *", key: "size", ph: "315/70 R22.5" },
              { label: "DOT", key: "dot", ph: "np. 1524" },
              { label: "Bieżnik [mm]", key: "tread_mm", ph: "np. 14.0" },
              { label: "Ilość", key: "quantity", ph: "1" },
              { label: "Lokalizacja", key: "location", ph: "np. regał A3" },
              { label: "Cena [PLN]", key: "price_pln", ph: "np. 1200" },
            ].map(({ label, key, ph }) => (
              <div key={key}>
                <label className="block text-xs text-slate-400 mb-1">{label}</label>
                <input type="text" placeholder={ph}
                  value={(form as Record<string, string>)[key]}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500" />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Stan</label>
              <select value={form.condition} onChange={e => setForm(f => ({ ...f, condition: e.target.value }))}
                className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-white">
                <option value="nowa">Nowa</option>
                <option value="uzywana">Używana</option>
                <option value="bieznikowana">Bieżnikowana</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Przeznaczenie</label>
              <select value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value as TirePurpose }))}
                className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-white">
                {(Object.keys(TIRE_PURPOSE_LABELS) as TirePurpose[]).map((p) => (
                  <option key={p} value={p}>{TIRE_PURPOSE_LABELS[p]}</option>
                ))}
              </select>
            </div>
            <button onClick={handleAdd} disabled={saving || !form.size}
              className="mt-4 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
              {saving ? "Zapisuję..." : "Zapisz"}
            </button>
            <button onClick={() => setShowAdd(false)}
              className="mt-4 text-slate-400 hover:text-white text-sm px-3 py-2">
              Anuluj
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-slate-400 text-sm">Ładowanie...</div>
      ) : items.length === 0 ? (
        <div className="text-slate-500 text-sm text-center py-8">Magazyn pusty</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700">
                <th className="pb-2 pr-3">Marka / model</th>
                <th className="pb-2 pr-3">Rozmiar</th>
                <th className="pb-2 pr-3">DOT</th>
                <th className="pb-2 pr-3">Stan</th>
                <th className="pb-2 pr-3">Bieżnik</th>
                <th className="pb-2 pr-3">Szt.</th>
                <th className="pb-2 pr-3">Pochodzenie</th>
                <th className="pb-2 pr-3">Lokalizacja</th>
                <th className="pb-2 pr-3">Cena</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/40">
              {items.map(item => (
                <tr key={item.id} className="hover:bg-slate-700/20">
                  <td className="py-2 pr-3 text-white font-medium">{item.brand}{item.model ? ` ${item.model}` : ""}</td>
                  <td className="py-2 pr-3 text-slate-300 font-mono text-xs">{item.size}</td>
                  <td className="py-2 pr-3 text-slate-400 text-xs">{item.dot ? parseDOT(item.dot) : "—"}</td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-1">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${item.condition === "nowa" ? "bg-green-800 text-green-200" : item.condition === "bieznikowana" ? "bg-blue-800 text-blue-200" : "bg-slate-600 text-slate-300"}`}>
                        {item.condition}
                      </span>
                      {item.is_scrap && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-red-900 text-red-200 font-semibold">ZŁOM</span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-slate-300">{item.tread_mm != null ? `${item.tread_mm} mm` : "—"}</td>
                  <td className="py-2 pr-3 text-white font-semibold">{item.quantity}</td>
                  <td className="py-2 pr-3 text-slate-400 text-xs">
                    {item.source === "zdjęcie"
                      ? `🔧 ${item.source_vehicle_reg ?? "?"} / ${item.source_position ?? "?"}${item.removed_reason ? ` (${item.removed_reason})` : ""}`
                      : item.source === "plac"
                      ? "🏗️ plac"
                      : "🛒 zakup"}
                  </td>
                  <td className="py-2 pr-3 text-slate-400 text-xs">{item.location ?? "—"}</td>
                  <td className="py-2 pr-3 text-slate-300">{item.price_pln != null ? `${item.price_pln.toLocaleString("pl-PL")} PLN` : "—"}</td>
                  <td className="py-2">
                    <button onClick={() => handleDelete(item.id)}
                      className="text-slate-500 hover:text-red-400 text-xs transition-colors">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Skaner kodów kreskowych magazyn */}
      {showScanner && (
        <BarcodeScanner
          onResult={handleBarcodeResult}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Główna strona /opony
// ══════════════════════════════════════════════════════════════
export default function OponyPage() {
  const [tab, setTab] = useState<Tab>("przeglad");
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [ciagnikReg, setCiagnikReg] = useState("");
  const [naczepReg, setNaczepReg] = useState("");
  const [tires, setTires] = useState<Tire[]>([]);
  const [latestReadings, setLatestReadings] = useState<Map<string, TireReading>>(new Map());
  const [selectedPos, setSelectedPos] = useState<{ id: string; vehicleReg: string } | null>(null);
  const [dataLoading, setDataLoading] = useState(false);

  // ── Wczytaj pojazdy ───────────────────────────────────────
  useEffect(() => {
    supabase
      .from("vehicles")
      .select("reg, vehicle_type, brand")
      .eq("is_active", true)
      .order("reg")
      .then(({ data }) => {
        setVehicles(data ?? []);
      });
  }, []);

  const ciagniks = vehicles.filter(v => v.vehicle_type === "ciągnik");
  const naczepy   = vehicles.filter(v => v.vehicle_type === "naczepa");

  // ── Wczytaj dane opon ─────────────────────────────────────
  const loadTireData = useCallback(async () => {
    const regs = [ciagnikReg, naczepReg].filter(Boolean);
    if (regs.length === 0) { setTires([]); setLatestReadings(new Map()); return; }
    setDataLoading(true);

    const { data: tiresData } = await supabase
      .from("tires")
      .select("*")
      .in("vehicle_reg", regs)
      .eq("status", "active");

    // Ostatnie odczyty: dla każdego pojazdu pobierz ostatnią inspekcję
    const readingMap = new Map<string, TireReading>();
    for (const reg of regs) {
      const { data: lastInsp } = await supabase
        .from("tire_inspections")
        .select("id")
        .eq("vehicle_reg", reg)
        .order("inspection_date", { ascending: false })
        .limit(1)
        .single();

      if (lastInsp) {
        const { data: rds } = await supabase
          .from("tire_readings")
          .select("*")
          .eq("inspection_id", lastInsp.id);
        (rds ?? []).forEach((r: TireReading) => {
          readingMap.set(`${reg}:${r.position}`, r);
        });
      }
    }

    setTires(tiresData ?? []);
    setLatestReadings(readingMap);
    setDataLoading(false);
  }, [ciagnikReg, naczepReg]);

  useEffect(() => { loadTireData(); }, [loadTireData]);

  // ── Mapa danych per pojazd i pozycja ─────────────────────
  function buildDataMap(vehicleReg: string, positions: TirePositionDef[]): Map<string, TireDisplayData> {
    const map = new Map<string, TireDisplayData>();
    positions.forEach(pos => {
      const tire = tires.find(t => t.vehicle_reg === vehicleReg && t.position === pos.id) ?? null;
      const reading = latestReadings.get(`${vehicleReg}:${pos.id}`) ?? null;
      const treadMin = reading ? minTread(reading) : null;
      const status = calcTireStatus({
        treadMm: treadMin,
        pressureBar: reading?.pressure_bar,
        dotCode: tire?.dot,
      });
      map.set(pos.id, { tire, reading, status, treadMin });
    });
    return map;
  }

  const ciagnikDataMap = buildDataMap(ciagnikReg, CIAGNIK_POSITIONS);
  const naczepDataMap  = buildDataMap(naczepReg,  NACZEPA_POSITIONS);

  // ── Status summary ────────────────────────────────────────
  function summary(dataMap: Map<string, TireDisplayData>) {
    let ok = 0, warn = 0, crit = 0, noData = 0;
    dataMap.forEach(d => {
      if (d.status === "ok") ok++;
      else if (d.status === "warning") warn++;
      else if (d.status === "critical") crit++;
      else noData++;
    });
    return { ok, warn, crit, noData };
  }

  const csumm = summary(ciagnikDataMap);
  const nsumm = summary(naczepDataMap);

  // ── Wybrany panel ─────────────────────────────────────────
  const selectedData = selectedPos
    ? (selectedPos.vehicleReg === ciagnikReg ? ciagnikDataMap : naczepDataMap).get(selectedPos.id)
    : null;

  // ── Etykieta pojazdu ─────────────────────────────────────
  function vehicleLabel(v: VehicleOption) {
    return `${v.reg}${v.brand ? ` (${v.brand})` : ""}`;
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      {/* ── Nagłówek ── */}
      <div className="bg-slate-800 border-b border-slate-700 px-6 py-4">
        <h1 className="text-xl font-bold text-white mb-0.5">🔵 Moduł Opon</h1>
        <p className="text-slate-400 text-sm">Wizualizacja, inspekcje i zarządzanie oponami floty</p>
      </div>

      {/* ── Zakładki ── */}
      <div className="bg-slate-800/60 border-b border-slate-700 px-6">
        <div className="flex gap-1">
          {([
            { id: "przeglad",  label: "Przegląd" },
            { id: "inspekcja", label: "Nowa inspekcja" },
            { id: "historia",  label: "Historia" },
            { id: "magazyn",   label: "Magazyn" },
          ] as const).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Zawartość ── */}
      <div className="p-6">

        {/* ── PRZEGLĄD ── */}
        {tab === "przeglad" && (
          <div className="space-y-5">
            {/* Wybór pojazdów */}
            <div className="grid grid-cols-2 gap-4 max-w-lg">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Ciągnik</label>
                <select value={ciagnikReg} onChange={e => { setCiagnikReg(e.target.value); setSelectedPos(null); }}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white">
                  <option value="">— wybierz —</option>
                  {ciagniks.map(v => <option key={v.reg} value={v.reg}>{vehicleLabel(v)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Naczepa</label>
                <select value={naczepReg} onChange={e => { setNaczepReg(e.target.value); setSelectedPos(null); }}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white">
                  <option value="">— wybierz —</option>
                  {naczepy.map(v => <option key={v.reg} value={v.reg}>{vehicleLabel(v)}</option>)}
                </select>
              </div>
            </div>

            {/* Legenda */}
            <StatusLegend />

            {/* Główny widok */}
            <div className="flex gap-5 flex-wrap">
              {/* Ciągnik */}
              {ciagnikReg && (
                <div className="flex-1 min-w-[280px] max-w-[360px]">
                  <div className="bg-slate-800 rounded-xl border border-slate-700 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <div className="font-semibold text-white text-sm">{ciagnikReg}</div>
                        <div className="text-slate-400 text-xs">Ciągnik 4×2 — 6 opon</div>
                      </div>
                      <div className="flex gap-1.5 text-xs">
                        {csumm.crit > 0 && <span className="bg-red-700 text-white px-2 py-0.5 rounded-full font-bold">{csumm.crit}✕</span>}
                        {csumm.warn > 0 && <span className="bg-amber-600 text-white px-2 py-0.5 rounded-full">{csumm.warn}⚠</span>}
                        {csumm.ok > 0   && <span className="bg-green-700 text-white px-2 py-0.5 rounded-full">{csumm.ok}✓</span>}
                      </div>
                    </div>
                    {dataLoading ? (
                      <div className="flex items-center justify-center h-40 text-slate-400 text-sm">Ładowanie...</div>
                    ) : (
                      <TruckSVG
                        dataMap={ciagnikDataMap}
                        selected={selectedPos?.vehicleReg === ciagnikReg ? selectedPos.id : null}
                        onTireClick={id => setSelectedPos({ id, vehicleReg: ciagnikReg })}
                      />
                    )}
                    <div className="text-center text-xs text-slate-500 mt-2">↑ Przód</div>
                  </div>
                </div>
              )}

              {/* Naczepa */}
              {naczepReg && (
                <div className="flex-1 min-w-[280px] max-w-[360px]">
                  <div className="bg-slate-800 rounded-xl border border-slate-700 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <div className="font-semibold text-white text-sm">{naczepReg}</div>
                        <div className="text-slate-400 text-xs">Naczepa 3-osiowa mega — 6 opon + 2 zapasowe</div>
                      </div>
                      <div className="flex gap-1.5 text-xs">
                        {nsumm.crit > 0 && <span className="bg-red-700 text-white px-2 py-0.5 rounded-full font-bold">{nsumm.crit}✕</span>}
                        {nsumm.warn > 0 && <span className="bg-amber-600 text-white px-2 py-0.5 rounded-full">{nsumm.warn}⚠</span>}
                        {nsumm.ok > 0   && <span className="bg-green-700 text-white px-2 py-0.5 rounded-full">{nsumm.ok}✓</span>}
                      </div>
                    </div>
                    {dataLoading ? (
                      <div className="flex items-center justify-center h-40 text-slate-400 text-sm">Ładowanie...</div>
                    ) : (
                      <TrailerSVG
                        dataMap={naczepDataMap}
                        selected={selectedPos?.vehicleReg === naczepReg ? selectedPos.id : null}
                        onTireClick={id => setSelectedPos({ id, vehicleReg: naczepReg })}
                      />
                    )}
                    <div className="text-center text-xs text-slate-500 mt-2">↑ Przód (kingpin)</div>
                  </div>
                </div>
              )}

              {/* Panel szczegółów */}
              {selectedPos && selectedData && (
                <div className="flex-1 min-w-[260px] max-w-[340px]">
                  <TireDetailPanel
                    positionId={selectedPos.id}
                    vehicleReg={selectedPos.vehicleReg}
                    data={selectedData}
                    onClose={() => setSelectedPos(null)}
                    onReload={loadTireData}
                  />
                </div>
              )}

              {/* Pusty stan */}
              {!ciagnikReg && !naczepReg && (
                <div className="flex-1 flex items-center justify-center h-64 text-slate-500">
                  <div className="text-center">
                    <div className="text-5xl mb-3">🚛</div>
                    <div className="text-lg font-medium mb-1">Wybierz pojazdy</div>
                    <div className="text-sm">aby zobaczyć wizualizację opon</div>
                  </div>
                </div>
              )}
            </div>

            {/* Instrukcja */}
            {(ciagnikReg || naczepReg) && !selectedPos && (
              <div className="text-xs text-slate-500 text-center mt-1">
                Kliknij na oponę, aby zobaczyć szczegóły i pomiary
              </div>
            )}
          </div>
        )}

        {/* ── NOWA INSPEKCJA ── */}
        {tab === "inspekcja" && (
          <div className="max-w-5xl">
            <InspectionForm
              vehicles={vehicles}
              onSaved={() => {
                loadTireData();
                setTab("historia");
              }}
            />
          </div>
        )}

        {/* ── HISTORIA ── */}
        {tab === "historia" && (
          <div className="max-w-4xl">
            <HistoryTab vehicles={vehicles} />
          </div>
        )}

        {/* ── MAGAZYN ── */}
        {tab === "magazyn" && (
          <div className="max-w-5xl">
            <WarehouseTab />
          </div>
        )}
      </div>
    </div>
  );
}
