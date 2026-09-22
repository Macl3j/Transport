import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/crmAuth";

// Powiadomienie na kanał Microsoft Teams (Akceptacje) o nowym zgłoszeniu do
// akceptacji albo o podjętej decyzji. Wymaga zmiennej środowiskowej
// TEAMS_WEBHOOK_URL — URL przepływu Power Automate utworzonego w Teams z
// szablonu "Wysyłaj alerty elementu webhook na kanał" (aplikacja Workflows →
// wyszukaj "webhook" → wybierz ten szablon → kanał Akceptacje). Stare
// "Incoming Webhook" (Connectors) jest w Teams wycofane, stąd ten szablon.
// Jego trigger oczekuje prostego {"text": "..."} — nie starego MessageCard.
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
    const lines = [`**${VERB[body.kind]}**`, `Kontrahent: ${body.vendor}`, `Kwota: ${amount}`];
    if (body.title) lines.push(`Tytuł: ${body.title}`);
    if (body.submittedByName) lines.push(`Zgłosił: ${body.submittedByName}`);
    if (body.kind !== "submitted" && body.decidedByName) lines.push(`Decyzja: ${body.decidedByName}`);
    if (body.kind === "rejected" && body.decisionNote) lines.push(`Powód odrzucenia: ${body.decisionNote}`);
    lines.push("", "https://transport-eight-gamma.vercel.app/akceptacje");

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lines.join("  \n") }),
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
