"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { SignaturePad } from "@/components/SignaturePad";

// ─── Typy ───────────────────────────────────────────────────────────────────
type ChecklistType = "initial" | "arrival";
type ItemStatus = "ok" | "brak" | "uszkodzone" | null;

interface EquipmentItem {
  id: string;
  name: string;
  requiredQty: string;
  category: string;
}

interface ChecklistItem extends EquipmentItem {
  status: ItemStatus;
  notes: string;
}

interface SavedChecklist {
  id: string;
  created_at: string;
  vehicle_reg: string;
  checklist_type: ChecklistType;
  driver_name: string | null;
  mechanic_name: string | null;
  km_reading: number | null;
  vehicle_condition: string | null;
  items: ChecklistItem[];
  overall_status: "complete" | "incomplete";
  notes: string | null;
  driver_signature: string | null;
  mechanic_signature: string | null;
}

// ─── Definicja wyposażenia ───────────────────────────────────────────────────
const EQUIPMENT: EquipmentItem[] = [
  // Asortyment ciągnik
  { id: "c_klucze_kola", category: "Asortyment ciągnik", name: "Zestaw kluczy do odkręcania kół", requiredQty: "1 szt." },
  { id: "c_lewarek", category: "Asortyment ciągnik", name: "Lewarek", requiredQty: "1 szt." },
  { id: "c_klucz_planetarny", category: "Asortyment ciągnik", name: "Klucz planetarny", requiredQty: "1 szt." },
  { id: "c_srubokrety", category: "Asortyment ciągnik", name: "Śrubokręty", requiredQty: "1 kpl." },
  { id: "c_klucze_plaskie", category: "Asortyment ciągnik", name: "Zestaw kluczy płasko oczkowych", requiredQty: "1 kpl." },
  { id: "c_torxy", category: "Asortyment ciągnik", name: "Torxy", requiredQty: "1 kpl." },
  { id: "c_kombinerki", category: "Asortyment ciągnik", name: "Kombinerki", requiredQty: "1 szt." },
  { id: "c_miara", category: "Asortyment ciągnik", name: "Miara", requiredQty: "1 szt." },
  { id: "c_skrzynka", category: "Asortyment ciągnik", name: "Skrzynka do narzędzi", requiredQty: "1 szt." },
  { id: "c_okulary", category: "Asortyment ciągnik", name: "Okulary bhp", requiredQty: "1 szt." },
  { id: "c_kask", category: "Asortyment ciągnik", name: "Kask", requiredQty: "1 szt." },
  { id: "c_noz", category: "Asortyment ciągnik", name: "Nóż", requiredQty: "1 szt." },
  { id: "c_gasnica", category: "Asortyment ciągnik", name: "Gaśnica", requiredQty: "1 szt." },
  { id: "c_mlotek", category: "Asortyment ciągnik", name: "Młotek", requiredQty: "1 szt." },

  // Naczepa asortyment
  { id: "n_pasy", category: "Naczepa asortyment", name: "Pasy i klamry", requiredQty: "25 szt." },
  { id: "n_narozniki", category: "Naczepa asortyment", name: "Narożniki", requiredQty: "50 szt." },
  { id: "n_drabina", category: "Naczepa asortyment", name: "Drabina", requiredQty: "1 szt." },
  { id: "n_deski", category: "Naczepa asortyment", name: "Deski zabezpieczające ładunek", requiredQty: "3 szt." },
  { id: "n_tyczka", category: "Naczepa asortyment", name: "Tyczka do otwierania dachu", requiredQty: "1 szt." },
  { id: "n_maty", category: "Naczepa asortyment", name: "Maty antypoślizgowe", requiredQty: "1 kpl." },
  { id: "n_kola", category: "Naczepa asortyment", name: "Koła zapasowe", requiredQty: "2 szt." },
  { id: "n_miotla", category: "Naczepa asortyment", name: "Miotła", requiredQty: "1 szt." },
];

const CATEGORIES = Array.from(new Set(EQUIPMENT.map((e) => e.category)));

// ─── Kolory statusów ─────────────────────────────────────────────────────────
const STATUS_BTN: Record<string, string> = {
  ok:         "bg-green-100 text-green-800 border-green-300",
  brak:       "bg-red-100 text-red-800 border-red-300",
  uszkodzone: "bg-yellow-100 text-yellow-800 border-yellow-300",
};
const STATUS_LABEL: Record<string, string> = {
  ok: "✓ OK", brak: "✗ Brak", uszkodzone: "⚠ Uszkodz.",
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function initItems(): ChecklistItem[] {
  return EQUIPMENT.map((e) => ({ ...e, status: null, notes: "" }));
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("pl-PL", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// KOMPONENT GŁÓWNY
// ═══════════════════════════════════════════════════════════════════════════
export default function ChecklistaPage() {
  const [type, setType] = useState<ChecklistType>("initial");
  const [vehicleReg, setVehicleReg]   = useState("");
  const [driverName, setDriverName]   = useState("");
  const [mechanicName, setMechanicName] = useState("");
  const [kmReading, setKmReading]     = useState("");
  const [vehicleCondition, setVehicleCondition] = useState("");
  const [checkDate, setCheckDate]     = useState(todayStr());
  const [items, setItems]             = useState<ChecklistItem[]>(initItems());
  const [notes, setNotes]             = useState("");
  const [saving, setSaving]           = useState(false);
  const [msg, setMsg]                 = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [history, setHistory]         = useState<SavedChecklist[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [printMode, setPrintMode]     = useState(false);
  const [savedId, setSavedId]         = useState<string | null>(null);
  const [driverSignature, setDriverSignature]     = useState<string | null>(null);
  const [mechanicSignature, setMechanicSignature] = useState<string | null>(null);
  const printRef = useRef<HTMLDivElement>(null);

  // ── statystyki ──────────────────────────────────────────────────────────
  const total   = items.length;
  const okCount = items.filter((i) => i.status === "ok").length;
  const brakCount = items.filter((i) => i.status === "brak").length;
  const uszCount  = items.filter((i) => i.status === "uszkodzone").length;
  const unchecked = items.filter((i) => i.status === null).length;
  const isComplete = brakCount === 0 && uszCount === 0 && unchecked === 0;

  // ── historia ────────────────────────────────────────────────────────────
  const loadHistory = useCallback(async (reg: string) => {
    setLoadingHistory(true);
    // Bez wpisanej rejestracji → ostatnie checklisty całej floty
    let query = supabase
      .from("equipment_checklists")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(reg.trim() ? 10 : 50);
    if (reg.trim()) query = query.ilike("vehicle_reg", reg.trim());
    const { data } = await query;
    setHistory((data as SavedChecklist[]) ?? []);
    setLoadingHistory(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => loadHistory(vehicleReg), 600);
    return () => clearTimeout(t);
  }, [vehicleReg, loadHistory]);

  // ── zmiana statusu pozycji ────────────────────────────────────────────
  function cycleStatus(id: string) {
    const order: (ItemStatus)[] = [null, "ok", "brak", "uszkodzone"];
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const idx = order.indexOf(it.status);
        return { ...it, status: order[(idx + 1) % order.length] };
      })
    );
  }

  function setItemStatus(id: string, st: ItemStatus) {
    setItems((prev) => prev.map((it) => (it.id !== id ? it : { ...it, status: st })));
  }

  function setItemNotes(id: string, val: string) {
    setItems((prev) => prev.map((it) => (it.id !== id ? it : { ...it, notes: val })));
  }

  function markAll(st: ItemStatus) {
    setItems((prev) => prev.map((it) => ({ ...it, status: st })));
  }

  // ── zapis ─────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!vehicleReg.trim()) { setMsg({ type: "err", text: "Podaj nr rejestracyjny" }); return; }
    setSaving(true); setMsg(null);
    try {
      const payload = {
        vehicle_reg:       vehicleReg.trim().toUpperCase(),
        checklist_type:    type,
        driver_name:       driverName   || null,
        mechanic_name:     mechanicName || null,
        km_reading:        kmReading ? parseInt(kmReading) : null,
        vehicle_condition: vehicleCondition || null,
        items,
        overall_status:    isComplete ? "complete" : "incomplete",
        notes:             notes || null,
        driver_signature:  driverSignature   || null,
        mechanic_signature: mechanicSignature || null,
      };
      const { data, error } = await supabase
        .from("equipment_checklists")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw error;
      setSavedId(data.id);
      setMsg({ type: "ok", text: "✓ Zapisano pomyślnie" });
      loadHistory(vehicleReg);
    } catch (e: unknown) {
      // Błąd Supabase to zwykły obiekt {message, details, hint, code} — nie instancja Error
      const err = e as { message?: string; details?: string; hint?: string; code?: string };
      const text = e instanceof Error
        ? e.message
        : err?.message
          ? [err.message, err.details, err.hint].filter(Boolean).join(" — ")
          : JSON.stringify(e);
      setMsg({ type: "err", text: `Błąd: ${text}` });
    } finally {
      setSaving(false);
    }
  }

  // ── drukowanie ────────────────────────────────────────────────────────
  function handlePrint() {
    setPrintMode(true);
    setTimeout(() => window.print(), 200);
  }

  useEffect(() => {
    function afterPrint() { setPrintMode(false); }
    window.addEventListener("afterprint", afterPrint);
    return () => window.removeEventListener("afterprint", afterPrint);
  }, []);

  // ── wczytaj zapisaną ─────────────────────────────────────────────────
  function loadSaved(c: SavedChecklist) {
    setType(c.checklist_type);
    setVehicleReg(c.vehicle_reg);
    setDriverName(c.driver_name ?? "");
    setMechanicName(c.mechanic_name ?? "");
    setKmReading(c.km_reading?.toString() ?? "");
    setVehicleCondition(c.vehicle_condition ?? "");
    setCheckDate(c.created_at.slice(0, 10));
    setItems(c.items.length ? c.items : initItems());
    setNotes(c.notes ?? "");
    setSavedId(c.id);
    setDriverSignature(c.driver_signature ?? null);
    setMechanicSignature(c.mechanic_signature ?? null);
    setMsg(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════
  return (
    <>
      {/* ── PRINT STYLES ── */}
      <style jsx global>{`
        @media print {
          body > * { display: none !important; }
          body > main { display: block !important; }
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          .print-section { page-break-inside: avoid; }
          @page { size: A4; margin: 12mm; }
        }
        .print-only { display: none; }
      `}</style>

      <div ref={printRef}>
        {/* ── NAGŁÓWEK STRONY ── */}
        <div className="no-print mb-6">
          <h1 className="text-2xl font-bold text-[#1F3864]">
            📋 Checklista wyposażenia pojazdu
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Pierwsze wyposażenie · Weryfikacja przyjazdu na bazę · Protokół przekazania
          </p>
        </div>

        {/* ── PRINT HEADER ── */}
        <div className="print-only mb-6 border-b-2 border-[#1F3864] pb-4">
          <div className="flex justify-between items-start">
            <div>
              <div className="text-xl font-bold text-[#1F3864]">B&M Investgroup</div>
              <div className="text-sm text-slate-500">System zarządzania flotą — HBM Audyt</div>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold">
                {type === "initial" ? "PROTOKÓŁ PIERWSZE WYPOSAŻENIE" : "PROTOKÓŁ WERYFIKACJI PRZYJAZDU"}
              </div>
              <div className="text-sm text-slate-500">Nr: {savedId?.slice(0, 8).toUpperCase() ?? "—"}</div>
            </div>
          </div>
        </div>

        {/* ── SELEKTOR TRYBU ── */}
        <div className="no-print flex gap-3 mb-6">
          {(["initial", "arrival"] as ChecklistType[]).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`px-5 py-2.5 rounded-lg font-semibold text-sm border-2 transition-all ${
                type === t
                  ? "bg-[#1F3864] text-white border-[#1F3864]"
                  : "bg-white text-slate-600 border-slate-200 hover:border-[#1F3864]"
              }`}
            >
              {t === "initial" ? "🏁 Pierwsze wyposażenie" : "🔍 Weryfikacja przyjazdu na bazę"}
            </button>
          ))}
        </div>

        {/* ── FORMULARZ NAGŁÓWKA ── */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 mb-6 shadow-sm">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Nr rejestracyjny *</label>
              <input
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono uppercase
                           focus:outline-none focus:ring-2 focus:ring-[#1F3864]"
                value={vehicleReg}
                onChange={(e) => setVehicleReg(e.target.value.toUpperCase())}
                placeholder="np. WA12345"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Kierowca</label>
              <input
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-[#1F3864]"
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
                placeholder="Imię i nazwisko"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Mechanik / kontrolujący</label>
              <input
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-[#1F3864]"
                value={mechanicName}
                onChange={(e) => setMechanicName(e.target.value)}
                placeholder="Imię i nazwisko"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">
                {type === "arrival" ? "Stan licznika (km)" : "Data wydania"}
              </label>
              {type === "arrival" ? (
                <input
                  type="number"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm
                             focus:outline-none focus:ring-2 focus:ring-[#1F3864]"
                  value={kmReading}
                  onChange={(e) => setKmReading(e.target.value)}
                  placeholder="np. 245000"
                />
              ) : (
                <input
                  type="date"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm
                             focus:outline-none focus:ring-2 focus:ring-[#1F3864]"
                  value={checkDate}
                  onChange={(e) => setCheckDate(e.target.value)}
                />
              )}
            </div>
            {type === "arrival" && (
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">Data przyjazdu</label>
                <input
                  type="date"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm
                             focus:outline-none focus:ring-2 focus:ring-[#1F3864]"
                  value={checkDate}
                  onChange={(e) => setCheckDate(e.target.value)}
                />
              </div>
            )}
            <div className={type === "arrival" ? "" : "col-span-2"}>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Uwagi ogólne</label>
              <input
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-[#1F3864]"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Opcjonalne uwagi..."
              />
            </div>
            <div className="col-span-2 md:col-span-3">
              <label className="block text-xs font-semibold text-slate-500 mb-1">Stan pojazdu (zarysowania, uszkodzenia itp.)</label>
              <textarea
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-[#1F3864]"
                rows={2}
                value={vehicleCondition}
                onChange={(e) => setVehicleCondition(e.target.value)}
                placeholder="np. zarysowany zderzak przód, prawe lusterko pęknięte..."
              />
            </div>
          </div>
        </div>

        {/* ── SKRÓTY ── */}
        <div className="no-print flex items-center gap-3 mb-4">
          <span className="text-xs text-slate-500 font-medium">Zaznacz wszystkie jako:</span>
          <button onClick={() => markAll("ok")}
            className="px-3 py-1 rounded-md text-xs font-semibold bg-green-100 text-green-800 border border-green-300 hover:bg-green-200">
            ✓ Wszystkie OK
          </button>
          <button onClick={() => markAll(null)}
            className="px-3 py-1 rounded-md text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200">
            ↺ Wyczyść
          </button>
          <span className="ml-auto text-xs text-slate-400">
            Kliknij pozycję lub przyciski status aby oznaczyć
          </span>
        </div>

        {/* ── LISTA WYPOSAŻENIA ── */}
        <div className="space-y-4 mb-6">
          {CATEGORIES.map((cat) => {
            const catItems = items.filter((i) => i.category === cat);
            return (
              <div key={cat} className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden print-section">
                {/* Nagłówek kategorii */}
                <div className="bg-[#1F3864] px-4 py-2.5">
                  <h2 className="text-white font-bold text-sm tracking-wide">{cat.toUpperCase()}</h2>
                </div>

                {/* Wiersze pozycji */}
                <div className="divide-y divide-slate-100">
                  {catItems.map((item, idx) => (
                    <div
                      key={item.id}
                      className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${
                        idx % 2 === 0 ? "bg-white" : "bg-slate-50"
                      }`}
                    >
                      {/* Lp */}
                      <span className="text-xs text-slate-400 w-6 shrink-0 text-right">
                        {EQUIPMENT.findIndex((e) => e.id === item.id) + 1}.
                      </span>

                      {/* Nazwa */}
                      <span className="flex-1 text-sm text-slate-800 min-w-0">{item.name}</span>

                      {/* Ilość — edytowalna */}
                      <input
                        className="no-print w-16 border border-slate-200 rounded px-1 py-0.5 text-xs
                                   font-semibold text-slate-600 text-center shrink-0
                                   focus:outline-none focus:ring-1 focus:ring-[#1F3864]"
                        value={item.requiredQty}
                        title="Edytuj ilość"
                        onChange={(e) =>
                          setItems((prev) =>
                            prev.map((it) =>
                              it.id !== item.id ? it : { ...it, requiredQty: e.target.value }
                            )
                          )
                        }
                      />
                      <span className="print-only text-xs font-semibold text-slate-500 w-16 text-center shrink-0">
                        {item.requiredQty}
                      </span>

                      {/* Przyciski statusu */}
                      <div className="flex gap-1.5 shrink-0 no-print">
                        {(["ok", "brak", "uszkodzone"] as ItemStatus[]).map((s) => (
                          <button
                            key={s!}
                            onClick={() => setItemStatus(item.id, item.status === s ? null : s)}
                            className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition-all ${
                              item.status === s
                                ? STATUS_BTN[s!] + " shadow-sm"
                                : "bg-white text-slate-400 border-slate-200 hover:border-slate-400"
                            }`}
                          >
                            {STATUS_LABEL[s!]}
                          </button>
                        ))}
                      </div>

                      {/* Status w druku */}
                      <div className="print-only w-24 text-center">
                        {item.status ? (
                          <span className={`text-xs font-bold ${
                            item.status === "ok" ? "text-green-700" :
                            item.status === "brak" ? "text-red-700" : "text-yellow-700"
                          }`}>
                            {STATUS_LABEL[item.status]}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </div>

                      {/* Uwagi do pozycji */}
                      <input
                        className="no-print w-32 xl:w-44 border border-slate-200 rounded px-2 py-1 text-xs
                                   text-slate-600 focus:outline-none focus:ring-1 focus:ring-[#1F3864]"
                        placeholder="uwagi..."
                        value={item.notes}
                        onChange={(e) => setItemNotes(item.id, e.target.value)}
                      />
                      {item.notes && (
                        <span className="print-only text-xs text-slate-500 italic">{item.notes}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── PODSUMOWANIE ── */}
        <div className={`rounded-xl p-4 mb-6 border-2 print-section ${
          unchecked > 0   ? "bg-slate-50 border-slate-200" :
          isComplete      ? "bg-green-50 border-green-300" :
                            "bg-orange-50 border-orange-300"
        }`}>
          <div className="flex flex-wrap items-center gap-4">
            <div className="text-sm font-bold text-slate-700">
              STATUS:{" "}
              <span className={
                unchecked > 0 ? "text-slate-500" :
                isComplete ? "text-green-700" : "text-orange-700"
              }>
                {unchecked > 0 ? `Niekompletna (brak ${unchecked} oz.)` :
                 isComplete ? "✓ KOMPLETNE" : "⚠ NIEKOMPLETNE"}
              </span>
            </div>
            <div className="flex gap-3 text-xs font-semibold ml-auto flex-wrap">
              <span className="text-green-700 bg-green-100 px-3 py-1 rounded-full">✓ OK: {okCount}</span>
              <span className="text-red-700 bg-red-100 px-3 py-1 rounded-full">✗ Brak: {brakCount}</span>
              <span className="text-yellow-700 bg-yellow-100 px-3 py-1 rounded-full">⚠ Uszkodz.: {uszCount}</span>
              <span className="text-slate-500 bg-slate-100 px-3 py-1 rounded-full">? Nieocenione: {unchecked}</span>
            </div>
          </div>
        </div>

        {/* ── PODPISY CYFROWE (ekran) ── */}
        <div className="no-print bg-white border border-slate-200 rounded-xl p-4 mb-6 shadow-sm">
          <h2 className="text-base font-bold text-slate-700 mb-4">✍️ Podpisy</h2>
          <p className="text-xs text-slate-400 mb-4">
            Podpisz palcem lub rysikiem na ekranie telefonu / tabletu. Podpisy zostaną zapisane razem z protokołem.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <SignaturePad
              label={`Kierowca${driverName ? ` — ${driverName}` : ""}`}
              onChange={setDriverSignature}
              initialValue={driverSignature}
            />
            <SignaturePad
              label={`Mechanik / kontrolujący${mechanicName ? ` — ${mechanicName}` : ""}`}
              onChange={setMechanicSignature}
              initialValue={mechanicSignature}
            />
          </div>
        </div>

        {/* ── PODPISY (druk) ── */}
        <div className="print-only grid grid-cols-3 gap-8 mt-8 pt-6 border-t border-slate-300">
          {/* Kierowca */}
          <div className="text-center">
            {driverSignature ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={driverSignature} alt="Podpis kierowcy" className="h-16 w-full object-contain mb-2" />
            ) : (
              <div className="h-14 border-b border-slate-400 mb-2" />
            )}
            <div className="text-xs text-slate-600 font-semibold">Podpis kierowcy</div>
            {driverName && <div className="text-xs text-slate-400">{driverName}</div>}
          </div>
          {/* Mechanik */}
          <div className="text-center">
            {mechanicSignature ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mechanicSignature} alt="Podpis mechanika" className="h-16 w-full object-contain mb-2" />
            ) : (
              <div className="h-14 border-b border-slate-400 mb-2" />
            )}
            <div className="text-xs text-slate-600 font-semibold">Podpis mechanika</div>
            {mechanicName && <div className="text-xs text-slate-400">{mechanicName}</div>}
          </div>
          {/* Data i pieczęć */}
          <div className="text-center">
            <div className="h-14 border-b border-slate-400 mb-2" />
            <div className="text-xs text-slate-600 font-semibold">Data i pieczęć</div>
          </div>
        </div>

        {/* ── PRZYCISKI AKCJI ── */}
        <div className="no-print flex flex-wrap items-center gap-3 mb-10">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2.5 bg-[#1F3864] text-white rounded-lg font-semibold text-sm
                       hover:bg-blue-900 disabled:opacity-50 transition-colors shadow"
          >
            {saving ? "Zapisywanie…" : "💾 Zapisz do bazy"}
          </button>
          <button
            onClick={handlePrint}
            className="px-6 py-2.5 bg-white text-[#1F3864] border-2 border-[#1F3864] rounded-lg font-semibold text-sm
                       hover:bg-blue-50 transition-colors shadow"
          >
            🖨️ Generuj dokument / Drukuj
          </button>
          <button
            onClick={() => { setItems(initItems()); setMsg(null); setSavedId(null); setVehicleCondition(""); }}
            className="px-4 py-2.5 bg-white text-slate-500 border border-slate-300 rounded-lg text-sm hover:bg-slate-50"
          >
            ↺ Nowa checklista
          </button>

          {msg && (
            <span className={`text-sm font-medium px-3 py-1 rounded-lg ${
              msg.type === "ok" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
            }`}>
              {msg.text}
            </span>
          )}
        </div>

        {/* ── HISTORIA ── */}
        <div className="no-print">
          <h2 className="text-lg font-bold text-slate-700 mb-3">
            {vehicleReg.trim() ? `Historia checklisty — ${vehicleReg.toUpperCase()}` : "Historia checklisty — cała flota"}
          </h2>
          {loadingHistory ? (
            <div className="text-sm text-slate-400">Ładowanie…</div>
          ) : history.length === 0 ? (
            <div className="text-sm text-slate-400 bg-slate-50 rounded-lg p-4">
              {vehicleReg.trim() ? "Brak zapisanych checklisty dla tego pojazdu." : "Brak zapisanych checklist."}
            </div>
          ) : (
              <div className="space-y-2">
                {history.map((c) => {
                  const cOk   = (c.items as ChecklistItem[]).filter((i) => i.status === "ok").length;
                  const cBrak = (c.items as ChecklistItem[]).filter((i) => i.status === "brak").length;
                  const cUsz  = (c.items as ChecklistItem[]).filter((i) => i.status === "uszkodzone").length;
                  return (
                    <div
                      key={c.id}
                      className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex flex-wrap
                                 items-center gap-3 cursor-pointer hover:border-[#1F3864] transition-colors"
                      onClick={() => loadSaved(c)}
                    >
                      {!vehicleReg.trim() && (
                        <span className="font-mono text-xs font-semibold text-blue-700 bg-blue-100 px-2 py-0.5 rounded">
                          {c.vehicle_reg}
                        </span>
                      )}
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                        c.checklist_type === "initial"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-purple-100 text-purple-700"
                      }`}>
                        {c.checklist_type === "initial" ? "Pierwsze wys." : "Weryfikacja"}
                      </span>
                      <span className="text-sm font-semibold text-slate-700">{fmtDate(c.created_at)}</span>
                      {c.driver_name && (
                        <span className="text-sm text-slate-500">👤 {c.driver_name}</span>
                      )}
                      {c.km_reading && (
                        <span className="text-sm text-slate-500">
                          🛞 {c.km_reading.toLocaleString("pl-PL")} km
                        </span>
                      )}
                      <span className="ml-auto flex gap-2 text-xs font-semibold">
                        <span className="text-green-700 bg-green-100 px-2 py-0.5 rounded-full">✓ {cOk}</span>
                        {cBrak > 0 && <span className="text-red-700 bg-red-100 px-2 py-0.5 rounded-full">✗ {cBrak}</span>}
                        {cUsz > 0 && <span className="text-yellow-700 bg-yellow-100 px-2 py-0.5 rounded-full">⚠ {cUsz}</span>}
                      </span>
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                        c.overall_status === "complete"
                          ? "bg-green-100 text-green-700"
                          : "bg-orange-100 text-orange-700"
                      }`}>
                        {c.overall_status === "complete" ? "KOMPLETNE" : "NIEKOMPLETNE"}
                      </span>
                      <span className="text-xs text-slate-400 hover:text-[#1F3864]">← wczytaj</span>
                    </div>
                  );
                })}
              </div>
          )}
        </div>
      </div>
    </>
  );
}
