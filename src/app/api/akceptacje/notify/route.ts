import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/crmAuth";

// Powiadomienie na kanał Microsoft Teams o nowym zgłoszeniu do akceptacji
// albo o podjętej decyzji. Wymaga zmiennej środowiskowej TEAMS_WEBHOOK_URL —
// URL "Incoming Webhook" utworzony w danym kanale Teams (Kanał → Connectors →
// Incoming Webhook). Nie da się tego skonfigurować z poziomu appki: ktoś z
// dostępem do Teams musi go raz utworzyć i wkleić jako sekret w Vercel.
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

const COLOR = { submitted: "F0611C", approved: "1E8E5A", rejected: "B3261E" };
const VERB = { submitted: "Nowe zgłoszenie do akceptacji", approved: "Płatność zatwierdzona", rejected: "Płatność odrzucona" };

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
    const facts = [
      { name: "Kontrahent", value: body.vendor },
      { name: "Kwota", value: amount },
    ];
    if (body.title) facts.push({ name: "Tytuł", value: body.title });
    if (body.submittedByName) facts.push({ name: "Zgłosił", value: body.submittedByName });
    if (body.kind !== "submitted" && body.decidedByName) facts.push({ name: "Decyzja", value: body.decidedByName });
    if (body.kind === "rejected" && body.decisionNote) facts.push({ name: "Powód odrzucenia", value: body.decisionNote });

    // Format "MessageCard" — starszy, ale wciąż działający standard dla
    // Incoming Webhook w Teams (Adaptive Cards wymagałyby bota/Power Automate).
    const card = {
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      themeColor: COLOR[body.kind],
      summary: VERB[body.kind],
      title: `B&M Invest Group — ${VERB[body.kind]}`,
      sections: [{ facts, markdown: true }],
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
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
