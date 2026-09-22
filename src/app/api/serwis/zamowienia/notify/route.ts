import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/crmAuth";

// Powiadomienie na kanał Microsoft Teams "Zamawianie części" o nowym
// zgłoszeniu do akceptacji albo o podjętej decyzji. Osobny webhook od
// /api/akceptacje/notify (inny kanał, inny przepływ Power Automate) —
// wymaga zmiennej środowiskowej PARTS_TEAMS_WEBHOOK_URL.
//
// Ten konkretny typ szablonu Teams ("Wysyłaj alerty elementu webhook na
// kanał") przekazuje całe ciało żądania wprost do akcji
// Post_card_in_a_chat_or_channel — wymaga GOTOWEJ Adaptive Card
// (type: AdaptiveCard), potwierdzone empirycznie przy /api/akceptacje/notify.
//
// Dopóki zmienna nie jest ustawiona, endpoint nic nie robi (nie blokuje
// zgłaszania/akceptowania zamówień) — tylko loguje ostrzeżenie na serwerze.

interface NotifyBody {
  kind: "submitted" | "approved" | "rejected";
  partName: string;
  quantity: number;
  estimatedCostPln?: number | null;
  vehicleReg?: string | null;
  vendor?: string | null;
  submittedByName?: string | null;
  decidedByName?: string | null;
  decisionNote?: string | null;
}

const VERB = { submitted: "🟠 Nowe zgłoszenie zamówienia części", approved: "✅ Zamówienie zatwierdzone", rejected: "🔴 Zamówienie odrzucone" };
const COLOR = { submitted: "Warning", approved: "Good", rejected: "Attention" } as const;

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser(req);
    if (!user) return NextResponse.json({ error: "Wymagane logowanie" }, { status: 401 });

    const body = (await req.json()) as NotifyBody;
    if (!body?.kind || !body.partName || typeof body.quantity !== "number") {
      return NextResponse.json({ error: "Brak wymaganych pól (kind, partName, quantity)" }, { status: 400 });
    }

    const webhookUrl = process.env.PARTS_TEAMS_WEBHOOK_URL;
    if (!webhookUrl) {
      console.warn("[serwis/zamowienia/notify] PARTS_TEAMS_WEBHOOK_URL nie jest ustawiony — pomijam powiadomienie na Teams.");
      return NextResponse.json({ ok: true, sent: false, reason: "PARTS_TEAMS_WEBHOOK_URL nieustawiony" });
    }

    const facts: { title: string; value: string }[] = [
      { title: "Część", value: body.partName },
      { title: "Ilość", value: String(body.quantity) },
    ];
    if (body.estimatedCostPln != null) {
      facts.push({ title: "Szacowany koszt", value: body.estimatedCostPln.toLocaleString("pl-PL", { maximumFractionDigits: 0 }) + " PLN" });
    }
    if (body.vehicleReg) facts.push({ title: "Pojazd", value: body.vehicleReg });
    if (body.vendor) facts.push({ title: "Dostawca", value: body.vendor });
    if (body.submittedByName) facts.push({ title: "Zgłosił", value: body.submittedByName });
    if (body.kind !== "submitted" && body.decidedByName) facts.push({ title: "Decyzja", value: body.decidedByName });
    if (body.kind === "rejected" && body.decisionNote) facts.push({ title: "Powód odrzucenia", value: body.decisionNote });

    const adaptiveCard = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        { type: "TextBlock", text: "B&M Invest Group — Warsztat", weight: "Lighter", size: "Small", spacing: "None" },
        { type: "TextBlock", text: VERB[body.kind], weight: "Bolder", size: "Medium", wrap: true, color: COLOR[body.kind] },
        { type: "FactSet", facts },
        { type: "TextBlock", text: "[Otwórz zamawianie części](https://transport-eight-gamma.vercel.app/serwis/zamowienia)", wrap: true, spacing: "Small" },
      ],
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adaptiveCard),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[serwis/zamowienia/notify] Teams webhook error", res.status, text);
      return NextResponse.json({ ok: false, sent: false, error: `Teams: HTTP ${res.status}` });
    }
    return NextResponse.json({ ok: true, sent: true });
  } catch (err) {
    console.error("[serwis/zamowienia/notify]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
