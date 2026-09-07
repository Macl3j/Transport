import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/crmAuth";

// Geokodowanie adresu/miasta na lat/lng przez OpenStreetMap Nominatim (darmowe,
// bez klucza). Zgodnie z polityką Nominatim: max 1 zapytanie/s, obowiązkowy
// identyfikujący User-Agent, wynik trzeba cache'ować (zapisujemy lat/lng w
// crm_contacts zamiast geokodować przy każdym wejściu na mapę).

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser(req);
    if (!user) {
      return NextResponse.json({ error: "Wymagane logowanie" }, { status: 401 });
    }

    const { query } = await req.json();
    if (!query || typeof query !== "string" || !query.trim()) {
      return NextResponse.json({ error: "Brak adresu do geokodowania" }, { status: 400 });
    }

    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "TruckCalc-HBM/1.0 (B&M Invest Group, wewnetrzny CRM)" },
    });
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Nominatim: HTTP ${res.status}` });
    }
    const results = await res.json();
    const hit = results?.[0];
    if (!hit) {
      return NextResponse.json({ ok: false, error: "Nie znaleziono lokalizacji dla tego adresu" });
    }
    return NextResponse.json({ ok: true, lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
