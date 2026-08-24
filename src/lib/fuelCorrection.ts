// ─────────────────────────────────────────────────────────────
// Korekta paliwowa (klauzula rewizji ceny transportu wg ON) — Hiszpania
// Podstawa prawna: Ley 15/2009, de 11 de noviembre, del contrato de transporte
// terrestre de mercancías, art. 38 + Orden FOM/1882/2012, de 1 de agosto, condición 3.
//
// Coeficiente G = wariancja średniej ceny ON między miesiącem zawarcia umowy
// a miesiącem faktycznej realizacji transportu — publikowana oficjalnie przez
// Ministerio de Transportes y Movilidad Sostenible:
// https://www.transportes.gob.es/transporte-terrestre/servicios-al-transportista/indice-de-variacionmensual-de-los-precios-medios-del-gasoleo-en-espana
//
// Tabela poniżej = "COEFICIENTE G APLICABLE A VEHÍCULOS CON MASA MÁXIMA
// AUTORIZADA ≥ 7.500 KG" (dotyczy floty B&M — wszystkie ciągniki > 20 000 kg).
// Stan na PDF zaktualizowany 10.08.2026, dane do lipca 2026 (kolejne miesiące
// publikowane z ok. 10-dniowym opóźnieniem po zamknięciu miesiąca).
//
// Wzór: ΔP = (G × P × coef) / 100, aktywny tylko gdy |G| >= 5%.
// ─────────────────────────────────────────────────────────────

// Miesiące kontraktowe (kolumny tabeli) — Lip.2024 .. Cze.2026
const CONTRACT_MONTHS = [
  "2024-07", "2024-08", "2024-09", "2024-10", "2024-11", "2024-12",
  "2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06",
  "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12",
  "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
];

// Miesiące realizacji (wiersze tabeli) — Sie.2024 .. Lip.2026
const EXEC_MONTHS = [
  "2024-08", "2024-09", "2024-10", "2024-11", "2024-12",
  "2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06",
  "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12",
  "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07",
];

// Wiersz i = wartości G% dla EXEC_MONTHS[i], kolumny = CONTRACT_MONTHS[0..i]
const ROWS: number[][] = [
  [-2.9],
  [-7.4, -4.7],
  [-7.3, -4.6, 0.1],
  [-5.5, -2.7, 2.0, 1.9],
  [-3.8, -0.9, 3.9, 3.8, 1.9],
  [-0.4, 2.6, 7.6, 7.5, 5.5, 3.5],
  [0.4, 3.4, 8.5, 8.3, 6.3, 4.3, 0.8],
  [-2.6, 0.3, 5.3, 5.1, 3.1, 1.3, -2.2, -2.9],
  [-5.8, -3.0, 1.8, 1.6, -0.3, -2.1, -5.4, -6.2, -3.3],
  [-8.4, -5.7, -1.0, -1.2, -3.0, -4.8, -8.0, -8.7, -6.0, -2.7],
  [-7.2, -4.4, 0.3, 0.1, -1.7, -3.5, -6.8, -7.5, -4.7, -1.5, 1.3],
  [-4.3, -1.5, 3.4, 3.2, 1.3, -0.6, -4.0, -4.7, -1.8, 1.6, 4.4, 3.1],
  [-5.2, -2.3, 2.5, 2.3, 0.4, -1.4, -4.8, -5.5, -2.7, 0.7, 3.5, 2.2, -0.9],
  [-5.5, -2.7, 2.1, 1.9, 0.0, -1.8, -5.1, -5.9, -3.0, 0.3, 3.1, 1.8, -1.2, -0.4],
  [-6.1, -3.3, 1.5, 1.3, -0.5, -2.4, -5.7, -6.4, -3.6, -0.3, 2.5, 1.2, -1.8, -1.0, -0.6],
  [-3.5, -0.6, 4.3, 4.1, 2.2, 0.3, -3.1, -3.9, -0.9, 2.5, 5.3, 4.0, 0.9, 1.8, 2.1, 2.7],
  [-5.5, -2.7, 2.1, 2.0, 0.1, -1.8, -5.1, -5.8, -3.0, 0.3, 3.2, 1.8, -1.2, -0.3, 0.0, 0.6, -2.1],
  [-6.9, -4.1, 0.6, 0.5, -1.4, -3.2, -6.5, -7.2, -4.4, -1.1, 1.7, 0.3, -2.6, -1.8, -1.4, -0.9, -3.5, -1.5],
  [-5.9, -3.1, 1.7, 1.5, -0.4, -2.2, -5.5, -6.3, -3.4, -0.1, 2.7, 1.4, -1.6, -0.8, -0.4, 0.2, -2.5, -0.5, 1.0],
  [23.6, 27.5, 32.7, 34.3, 30.0, 28.9, 24.3, 18.7, 27.1, 30.3, 36.0, 32.6, 29.8, 30.9, 29.9, 32.3, 27.1, 31.3, 33.6, 25.7],
  [43.6, 48.8, 58.6, 57.5, 54.7, 50.4, 44.3, 45.4, 48.2, 55.3, 59.8, 58.1, 51.5, 53.1, 54.7, 54.9, 50.8, 53.7, 56.5, 55.2, 12.1],
  [30.0, 34.0, 40.9, 40.7, 38.0, 35.4, 30.5, 29.5, 33.6, 38.4, 42.5, 40.5, 36.2, 37.4, 37.9, 38.8, 34.9, 37.9, 40.0, 38.5, 4.6, -6.0],
  [20.0, 23.7, 30.1, 29.9, 27.3, 24.9, 20.5, 19.5, 23.3, 27.7, 31.5, 29.7, 25.7, 26.8, 27.3, 28.1, 24.5, 27.2, 29.2, 27.9, -3.5, -13.2, -7.7],
  [13.9, 17.5, 23.5, 23.3, 20.9, 18.6, 14.4, 13.5, 17.1, 21.3, 24.8, 23.1, 19.3, 20.4, 20.9, 21.6, 18.2, 20.8, 22.7, 21.4, -8.4, -17.6, -12.4, -5.1],
];

const G_TABLE = new Map<string, Map<string, number>>();
ROWS.forEach((vals, i) => {
  const row = new Map<string, number>();
  vals.forEach((g, j) => row.set(CONTRACT_MONTHS[j], g));
  G_TABLE.set(EXEC_MONTHS[i], row);
});

export const G_TABLE_LAST_EXEC_MONTH = EXEC_MONTHS[EXEC_MONTHS.length - 1]; // "2026-07"

/** Zwraca G% (np. -5.1) dla pary (miesiąc realizacji, miesiąc zawarcia umowy), albo null gdy
 *  ministerstwo nie publikuje wartości dla tej kombinacji (ten sam miesiąc, albo miesiąc
 *  realizacji jeszcze nieopublikowany). */
export function lookupG(execMonth: string, contractMonth: string): number | null {
  const row = G_TABLE.get(execMonth);
  if (!row) return null;
  const v = row.get(contractMonth);
  return v === undefined ? null : v;
}

export const FUEL_REVISION_THRESHOLD_PCT = 5;

// Współczynniki wg wzorów a)-d) — Orden FOM/1882/2012, warianty wagowe pojazdu
export type VehicleWeightClass = "ge20000" | "35to20000" | "construction" | "le3500";

export const FUEL_COEFFICIENTS: Record<VehicleWeightClass, number> = {
  ge20000: 0.30,       // MMA >= 20 000 kg (poza budowlanymi) — standardowe ciągniki TIR B&M
  "35to20000": 0.20,   // 3 500 kg < MMA < 20 000 kg (poza budowlanymi)
  construction: 0.20,  // pojazdy budowlane MMA > 3 500 kg
  le3500: 0.10,        // MMA <= 3 500 kg
};

export interface FuelCorrectionResult {
  g: number | null;          // % wariancji ON, null = brak danych publikowanych
  thresholdMet: boolean;     // |g| >= 5%
  deltaP: number | null;     // EUR — kwota korekty (dodatnia = dopłata, ujemna = zwrot)
}

/** Liczy korektę paliwową dla jednego zlecenia/koszyka zleceń. */
export function calcFuelCorrection(
  execMonth: string,
  contractMonth: string,
  priceP: number,
  weightClass: VehicleWeightClass = "ge20000"
): FuelCorrectionResult {
  const g = lookupG(execMonth, contractMonth);
  if (g === null) return { g: null, thresholdMet: false, deltaP: null };
  const thresholdMet = Math.abs(g) >= FUEL_REVISION_THRESHOLD_PCT;
  const coef = FUEL_COEFFICIENTS[weightClass];
  const deltaP = thresholdMet ? (g * priceP * coef) / 100 : 0;
  return { g, thresholdMet, deltaP };
}
