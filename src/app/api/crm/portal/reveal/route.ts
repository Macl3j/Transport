import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { decryptSecret } from "@/lib/crmCrypto";

// Odszyfrowuje hasło do portalu na żądanie (kliknięcie "Pokaż hasło").
// Plaintext istnieje tylko w tej odpowiedzi — nigdy nie jest przechowywany
// w bazie ani w stanie aplikacji poza chwilą wyświetlenia.
export async function POST(req: Request) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "Brak id" }, { status: 400 });

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("crm_tender_portals")
      .select("password_encrypted")
      .eq("id", id)
      .single();
    if (error) throw error;
    if (!data?.password_encrypted) {
      return NextResponse.json({ ok: true, password: null });
    }

    const password = decryptSecret(data.password_encrypted);
    return NextResponse.json({ ok: true, password });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
