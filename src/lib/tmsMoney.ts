// Kwoty z eksportu TMS to tekst z walutą, np. "400,00 EUR", "0,00 PLN", "1 234,50 EUR".

/** Nagłówek kolumny eksportu TMS z dodatkowym kosztem trasy (promy, tunele) ponad myto na trasie. */
export const TMS_EXTRA_TOLL_HEADER = "zleceniodawca myto";

/**
 * Zamienia kwotę z walutą na EUR. Puste pole, brak kwoty albo waluta inna niż EUR/PLN
 * daje 0 — tej funkcji używamy do kosztów dodatkowych, gdzie brak wartości = brak pozycji.
 */
export function parseMoneyEur(raw: string, plnEurRate: number): number {
  if (!raw) return 0;
  const str = String(raw).replace(/\s/g, "").toUpperCase();
  const suf = str.match(/(-?[\d.,]+)([A-ZŁ€]{1,3})/);
  const pre = suf ? null : str.match(/([A-ZŁ€]{1,3})(-?[\d.,]+)/);
  if (!suf && !pre) return 0;
  const numStr = suf ? suf[1] : pre![2];
  const curRaw = suf ? suf[2] : pre![1];
  // "1.234,56" (kropka tysięcy + przecinek dziesiętny), "1234,56" i "1,234.56"
  let norm = numStr;
  if (norm.includes(",") && norm.includes(".")) {
    norm = norm.lastIndexOf(",") > norm.lastIndexOf(".")
      ? norm.replace(/\./g, "").replace(",", ".")
      : norm.replace(/,/g, "");
  } else norm = norm.replace(",", ".");
  const amount = parseFloat(norm);
  if (isNaN(amount) || amount <= 0) return 0;
  const currency = curRaw === "ZŁ" ? "PLN" : curRaw === "€" ? "EUR" : curRaw;
  if (currency === "EUR") return Math.round(amount * 100) / 100;
  if (currency === "PLN" && plnEurRate > 0) return Math.round((amount / plnEurRate) * 100) / 100;
  return 0;
}
