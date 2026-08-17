// ============================================================
// crmCrypto.ts — HBM TruckCalc
// Szyfrowanie haseł do portali przetargowych (AES-256-GCM).
// SERVER-ONLY: importować wyłącznie w src/app/api/crm/** (route.ts).
// Nigdy nie importować w komponentach "use client" — użycie w
// przeglądarce ujawniłoby CRM_ENCRYPTION_KEY w bundlu klienta.
// ============================================================

import crypto from "crypto";

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const raw = process.env.CRM_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("CRM_ENCRYPTION_KEY nie jest ustawiony w zmiennych środowiskowych");
  }
  // Dowolny sekret → deterministyczny klucz 32-bajtowy (AES-256)
  return crypto.createHash("sha256").update(raw).digest();
}

/** Zwraca "iv.tag.ciphertext" (każdy segment base64) — do zapisu w bazie */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

/** Odwraca encryptSecret() — zwraca oryginalny plaintext */
export function decryptSecret(stored: string): string {
  const [ivB64, tagB64, ctB64] = stored.split(".");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("Nieprawidłowy format zaszyfrowanego hasła");
  }
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
