import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/crmAuth";

// Powiadomienie na kanał Microsoft Teams (Akceptacje) o nowym zgłoszeniu do
// akceptacji albo o podjętej decyzji. Wymaga zmiennej środowiskowej
// TEAMS_WEBHOOK_URL — URL przepływu Power Automate utworzonego w Teams z
// szablonu "Wysyłaj alerty elementu webhook na kanał" (aplikacja Workflows →
// wyszukaj "webhook" → wybierz ten szablon → kanał Akceptacje). Stare
// "Incoming Webhook" (Connectors) jest w Teams wycofane, stąd ten szablon.
//
// WAŻNE: ten konkretny przepływ przekazuje całe ciało żądania wprost do akcji
// "Post card in a chat or channel" — oczekuje więc GOTOWEJ Adaptive Card
// (JSON z "type": "AdaptiveCard"), a nie prostego {"text": "..."} ani
// starego formatu MessageCard. Potwierdzone empirycznie: próba z {"text"}
// kończyła się błędem "Property 'type' must be 'AdaptiveCard'" w historii
// przebiegów przepływu.
//
// Dopóki zmienna nie jest ustawiona, endpoint nic nie robi (nie blokuje
// zgłaszania/akceptowania płatności) — tylko loguje ostrzeżenie na serwerze.

interface NotifyBody {
  kind: "submitted" | "approved" | "rejected";
  vendor: string;
  amountPln: number;
  title?: string | null;
  submittedByName?: string | null;
  decidedByName?: string | null;
  decisionNote?: string | null;
}

const VERB = { submitted: "🟠 Nowe zgłoszenie do akceptacji", approved: "✅ Płatność zatwierdzona", rejected: "🔴 Płatność odrzucona" };
const COLOR = { submitted: "Warning", approved: "Good", rejected: "Attention" } as const;

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser(req);
    if (!user) return NextResponse.json({ error: "Wymagane logowanie" }, { status: 401 });

    const body = (await req.json()) as NotifyBody;
    if (!body?.kind || !body.vendor || typeof body.amountPln !== "number") {
      return NextResponse.json({ error: "Brak wymaganych pól (kind, vendor, amountPln)" }, { status: 400 });
    }

    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) {
      console.warn("[akceptacje/notify] TEAMS_WEBHOOK_URL nie jest ustawiony — pomijam powiadomienie na Teams.");
      return NextResponse.json({ ok: true, sent: false, reason: "TEAMS_WEBHOOK_URL nieustawiony" });
    }

    const amount = body.amountPln.toLocaleString("pl-PL", { maximumFractionDigits: 0 }) + " PLN";
    const facts: { title: string; value: string }[] = [
      { title: "Kontrahent", value: body.vendor },
      { title: "Kwota", value: amount },
    ];
    if (body.title) facts.push({ title: "Tytuł", value: body.title });
    if (body.submittedByName) facts.push({ title: "Zgłosił", value: body.submittedByName });
    if (body.kind !== "submitted" && body.decidedByName) facts.push({ title: "Decyzja", value: body.decidedByName });
    if (body.kind === "rejected" && body.decisionNote) facts.push({ title: "Powód odrzucenia", value: body.decisionNote });

    const adaptiveCard = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        { type: "TextBlock", text: "B&M Invest Group", weight: "Lighter", size: "Small", spacing: "None" },
        { type: "TextBlock", text: VERB[body.kind], weight: "Bolder", size: "Medium", wrap: true, color: COLOR[body.kind] },
        { type: "FactSet", facts },
        { type: "TextBlock", text: "[Otwórz moduł akceptacji](https://transport-eight-gamma.vercel.app/akceptacje)", wrap: true, spacing: "Small" },
      ],
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adaptiveCard),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[akceptacje/notify] Teams webhook error", res.status, text);
      return NextResponse.json({ ok: false, sent: false, error: `Teams: HTTP ${res.status}` });
    }
    return NextResponse.json({ ok: true, sent: true });
  } catch (err) {
    console.error("[akceptacje/notify]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
