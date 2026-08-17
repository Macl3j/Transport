import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { encryptSecret } from "@/lib/crmCrypto";

// Tworzy/aktualizuje login do portalu przetargowego.
// Hasło jest szyfrowane TUTAJ (server-side) — nigdy nie trafia do bazy jawnym tekstem.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { id, contact_id, portal_name, portal_url, username, password, notes } = body;

    if (!contact_id) {
      return NextResponse.json({ error: "Brak contact_id" }, { status: 400 });
    }

    const supabase = createServiceClient();
    const payload: Record<string, unknown> = {
      contact_id,
      portal_name: portal_name || null,
      portal_url:  portal_url  || null,
      username:    username    || null,
      notes:       notes       || null,
      updated_at:  new Date().toISOString(),
    };
    // Hasło aktualizowane tylko, gdy podano nowe (pusty formularz = zostaw stare)
    if (password) {
      payload.password_encrypted = encryptSecret(String(password));
    }

    if (id) {
      const { error } = await supabase.from("crm_tender_portals").update(payload).eq("id", id);
      if (error) throw error;
      return NextResponse.json({ ok: true, id });
    } else {
      const { data, error } = await supabase
        .from("crm_tender_portals")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw error;
      return NextResponse.json({ ok: true, id: data.id });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "Brak id" }, { status: 400 });
    const supabase = createServiceClient();
    const { error } = await supabase.from("crm_tender_portals").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
