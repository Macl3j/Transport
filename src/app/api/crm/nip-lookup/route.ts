import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/crmAuth";

// Szuka adresu siedziby firmy na podstawie NIP/VAT-UE.
// Polskie NIP (10 cyfr, bez prefiksu kraju) -> biała lista MF (wl-api.mf.gov.pl).
// Zagraniczne VAT UE (2-literowy prefiks kraju) -> VIES (ec.europa.eu).
// Uwaga: VIES strukturalnie nie zwraca adresu dla DE i ES (znane ograniczenie
// całej usługi, nie błąd tego kodu) — te przypadki trzeba wypełnić ręcznie.

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function parsePolishAddress(workingAddress: string): { address: string; city: string | null } {
  // Format: "ULICA NR, KOD-POCZTOWY MIEJSCOWOŚĆ"
  const parts = workingAddress.split(",").map((s) => s.trim());
  const street = parts[0] ?? "";
  const rest = parts[1] ?? "";
  const cityMatch = rest.match(/^\d{2}-\d{3}\s+(.+)$/);
  const city = cityMatch ? cityMatch[1].trim() : rest || null;
  return { address: workingAddress, city };
}

function parseViesAddress(raw: string): { address: string; city: string | null } {
  const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  const address = lines.join(", ");
  const cityLine = lines[lines.length - 1] ?? "";
  const cityMatch = cityLine.match(/^[A-Z0-9-]+\s+(.+)$/i);
  const city = cityMatch ? cityMatch[1].trim() : cityLine || null;
  return { address, city };
}

async function lookupPolish(nip: string) {
  const res = await fetch(`https://wl-api.mf.gov.pl/api/search/nip/${nip}?date=${todayStr()}`);
  if (!res.ok) return { ok: false as const, error: `Biała lista MF: HTTP ${res.status}` };
  const json = await res.json();
  const entry = json?.result?.subject;
  if (!entry?.workingAddress && !entry?.residenceAddress) {
    return { ok: false as const, error: "Biała lista MF: brak danych adresowych dla tego NIP" };
  }
  const parsed = parsePolishAddress(entry.workingAddress || entry.residenceAddress);
  return { ok: true as const, ...parsed, source: "nip_lookup", name: entry.name as string | undefined };
}

async function lookupVies(countryCode: string, vatNumber: string) {
  const res = await fetch(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${countryCode}/vat/${vatNumber}`);
  if (!res.ok) return { ok: false as const, error: `VIES: HTTP ${res.status}` };
  const json = await res.json();
  if (!json?.isValid) return { ok: false as const, error: "VIES: numer VAT nieaktywny lub nie znaleziono" };
  const rawAddress = (json.address || "").trim();
  if (!rawAddress || rawAddress === "---") {
    return {
      ok: false as const,
      error: `VIES nie udostępnia adresu dla kraju ${countryCode} (znane ograniczenie usługi VIES, dotyczy m.in. DE/ES) — wpisz adres ręcznie`,
    };
  }
  const parsed = parseViesAddress(rawAddress);
  return { ok: true as const, ...parsed, source: "nip_lookup", name: (json.name || "").trim() || undefined };
}

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser(req);
    if (!user) {
      return NextResponse.json({ error: "Wymagane logowanie" }, { status: 401 });
    }

    const { nip } = await req.json();
    if (!nip || typeof nip !== "string") {
      return NextResponse.json({ error: "Brak NIP" }, { status: 400 });
    }

    const cleaned = nip.replace(/[\s-]/g, "").toUpperCase();

    let result;
    if (/^\d{10}$/.test(cleaned)) {
      result = await lookupPolish(cleaned);
    } else {
      const m = cleaned.match(/^([A-Z]{2})([A-Z0-9]+)$/);
      if (!m) {
        return NextResponse.json({ error: "Nierozpoznany format NIP/VAT" }, { status: 400 });
      }
      const [, countryCode, vatNumber] = m;
      result = await lookupVies(countryCode, vatNumber);
    }

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 200 });
    }
    return NextResponse.json({ ok: true, address: result.address, city: result.city, source: result.source, name: result.name });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
