// ─────────────────────────────────────────────────────────────
// Korekta paliwowa (klauzula rewizji ceny transportu wg ON) — Hiszpania
// Podstawa prawna: Ley 15/2009, de 11 de noviembre, del contrato de transporte
// terrestre de mercancías, art. 38 + Orden FOM/1882/2012, de 1 de agosto,
// condición 3, zaktualizowana Real Decreto-ley 9/2026 (14.04.2026) i
// Real Decreto-ley 18/2026 (29.06.2026) w ramach Planu Integral de Respuesta
// a la Crisis en Oriente Medio.
//
// G = wariancja TYGODNIOWEJ ceny referencyjnej ON (Pmed, MMA >= 7 500 kg)
// między dokładną datą zawarcia umowy a dokładną datą realizacji transportu
// (nie przybliżenie miesiąc-do-miesiąca) — potwierdzone jako metoda prawnie
// wiążąca w "Nota metodológica" Ministerio de Transportes y Movilidad
// Sostenible (2026-07-02): "la variable G equivale al índice de variación
// porcentual del precio medio SEMANAL del gasóleo".
// Źródło danych: https://apps.fomento.gob.es/preciogasoleo/ — arkusz
// tygodniowy PRECIOS DE REFERENCIA, kolumna ge75t.
//
// Reguła dopasowania daty do tygodnia: bierzemy najbliższą datę z serii
// tygodniowej >= data docelowa (tak samo działa oficjalny kalkulator rządowy
// — zweryfikowane na dwóch niezależnych parach dat w interfejsie kalkulatora).
//
// Wzór: ΔP = (G × P × coef) / 100, aktywny tylko gdy |G| >= 5%.
//
// Zmiana metodologii (sierpień 2026): zastępuje wcześniejszą tabelę
// miesięczną (COEFICIENTE G APLICABLE...) i współczynnik 0,30 dla floty
// >=20 000 kg — oba były nieaktualne. Zweryfikowane na realnych fakturach
// korekty paliwowej Trans Sesé S.L. za czerwiec/lipiec 2026.
// ─────────────────────────────────────────────────────────────

/** [data jako serial Excela (dni od 1899-12-30), cena €/L Pmed dla MMA>=7500kg] —
 *  oficjalny tygodniowy biuletyn cenowy ON, pobrany 2026-08-25. To jest
 *  DOMYŚLNA/wbudowana seria (fallback) — strona /korekty-paliwowe pozwala
 *  wgrać świeższy oficjalny plik XLSX, co dokłada nowsze tygodnie przez
 *  loadPriceSeries() i zapisuje je w tabeli Supabase `fuel_price_series`,
 *  żeby przetrwały między sesjami bez zmiany tego pliku. */
const PRICE_SERIES_RAW: [number, number][] = [
  [43472,0.88475],[43479,0.90003],[43486,0.91488],[43493,0.92429],[43500,0.9303],[43507,0.93518],[43514,0.94303],[43521,0.95917],
  [43528,0.96378],[43535,0.96659],[43542,0.96761],[43549,0.96627],[43556,0.96622],[43563,0.96959],[43570,0.97763],[43584,0.99015],
  [43591,0.99074],[43598,0.99062],[43605,0.99159],[43612,0.9931],[43619,0.98167],[43626,0.95854],[43633,0.94207],[43640,0.93797],
  [43647,0.94395],[43654,0.94704],[43661,0.95145],[43668,0.95393],[43675,0.9527],[43682,0.95655],[43689,0.94948],[43696,0.94297],
  [43703,0.94129],[43710,0.94076],[43717,0.94288],[43724,0.95031],[43731,0.96439],[43738,0.96726],[43745,0.96009],[43752,0.95364],
  [43759,0.95244],[43766,0.95256],[43773,0.95468],[43780,0.9558],[43787,0.95476],[43794,0.95474],[43801,0.95858],[43808,0.95801],
  [43815,0.9601],[43836,0.98164],[43843,0.98732],[43850,0.98123],[43857,0.97246],[43864,0.96042],[43871,0.94789],[43878,0.94303],
  [43885,0.94402],[43892,0.93452],[43899,0.91883],[43906,0.88307],[43913,0.8476],[43920,0.82489],[43927,0.80871],[43941,0.7958],
  [43948,0.77728],[43955,0.76209],[43962,0.7615],[43969,0.76505],[43976,0.77576],[43983,0.779],[43990,0.78402],[43997,0.79329],
  [44004,0.80059],[44011,0.81079],[44018,0.81527],[44025,0.82414],[44032,0.82745],[44039,0.82955],[44046,0.82783],[44053,0.8269],
  [44060,0.82804],[44067,0.82807],[44074,0.82656],[44081,0.82273],[44088,0.8106],[44095,0.80542],[44102,0.80262],[44109,0.80135],
  [44116,0.80213],[44123,0.80217],[44130,0.79859],[44137,0.79194],[44144,0.78924],[44151,0.79798],[44158,0.80378],[44165,0.81316],
  [44172,0.81755],[44179,0.82526],[44186,0.83448],[44207,0.84797],[44214,0.85942],[44221,0.86555],[44228,0.86684],[44235,0.87604],
  [44242,0.88792],[44249,0.90193],[44256,0.91393],[44263,0.92066],[44270,0.93228],[44277,0.93673],[44284,0.92972],[44298,0.9254],
  [44305,0.92606],[44312,0.92908],[44319,0.93306],[44326,0.94257],[44333,0.94935],[44340,0.95155],[44347,0.95299],[44354,0.96033],
  [44361,0.96892],[44368,0.97428],[44375,0.98121],[44382,0.98721],[44389,0.99445],[44396,0.99854],[44403,0.9954],[44410,1.00038],
  [44417,1.00095],[44424,0.99741],[44431,0.99266],[44438,0.99147],[44445,0.99698],[44452,1.00121],[44459,1.00874],[44466,1.01792],
  [44473,1.03321],[44480,1.05455],[44487,1.0732],[44494,1.08617],[44501,1.09311],[44508,1.09509],[44515,1.09616],[44522,1.09197],
  [44529,1.08865],[44536,1.07065],[44543,1.06393],[44550,1.06204],[44564,1.06435],[44571,1.07484],[44578,1.09204],[44585,1.11118],
  [44592,1.12635],[44599,1.14406],[44606,1.15984],[44613,1.17372],[44620,1.18802],[44627,1.25762],[44634,1.45295],[44641,1.43664],
  [44648,1.46934],[44655,1.31218],[44662,1.28478],[44676,1.47779],[44683,1.49876],[44690,1.53074],[44697,1.51056],[44704,1.494],
  [44711,1.48175],[44718,1.53522],[44725,1.60698],[44732,1.66714],[44739,1.68693],[44746,1.66711],[44753,1.62249],[44760,1.58043],
  [44767,1.54857],[44774,1.51573],[44781,1.48345],[44788,1.44363],[44795,1.45195],[44802,1.50683],[44809,1.53878],[44816,1.52598],
  [44823,1.49479],[44830,1.45679],[44837,1.4455],[44844,1.48538],[44851,1.56191],[44858,1.5815],[44865,1.58028],[44872,1.57412],
  [44879,1.55422],[44886,1.50206],[44893,1.45643],[44900,1.40882],[44907,1.36503],[44914,1.32435],[44921,1.30914],[44928,1.32357],
  [44935,1.34103],[44942,1.33867],[44949,1.3463],[44956,1.3593],[44963,1.3373],[44970,1.29707],[44977,1.28274],[44984,1.26431],
  [44998,1.26725],[45005,1.24938],[45012,1.2286],[45019,1.21543],[45026,1.21027],[45033,1.20699],[45040,1.18774],[45047,1.16149],
  [45054,1.13589],[45061,1.11793],[45068,1.11555],[45075,1.12112],[45082,1.12223],[45089,1.12799],[45096,1.13046],[45103,1.14223],
  [45110,1.13907],[45117,1.14079],[45124,1.15222],[45131,1.162],[45138,1.19215],[45145,1.23419],[45152,1.2619],[45159,1.27489],
  [45166,1.28345],[45173,1.29217],[45180,1.30154],[45187,1.32973],[45194,1.34431],[45201,1.34579],[45208,1.34172],[45215,1.32032],
  [45222,1.318],[45229,1.31115],[45236,1.30704],[45243,1.27917],[45250,1.25437],[45257,1.23909],[45264,1.22627],[45271,1.21265],
  [45278,1.19204],[45285,1.18485],[45292,1.18542],[45299,1.18077],[45306,1.17735],[45313,1.17978],[45320,1.18721],[45327,1.20137],
  [45334,1.21372],[45341,1.23884],[45348,1.24135],[45355,1.23385],[45362,1.22578],[45369,1.21742],[45376,1.22381],[45383,1.22526],
  [45390,1.2333],[45397,1.24069],[45404,1.23922],[45411,1.22515],[45418,1.21642],[45425,1.20086],[45432,1.18685],[45439,1.17783],
  [45446,1.16986],[45453,1.15532],[45460,1.15225],[45467,1.16628],[45474,1.18092],[45481,1.1905],[45488,1.19069],[45495,1.18454],
  [45502,1.17683],[45509,1.16886],[45516,1.15708],[45523,1.15205],[45530,1.13922],[45537,1.12806],[45544,1.113],[45551,1.09181],
  [45558,1.0811],[45565,1.07695],[45572,1.07697],[45579,1.09463],[45586,1.10185],[45593,1.10212],[45600,1.10097],[45607,1.10742],
  [45614,1.11313],[45621,1.12474],[45628,1.13371],[45635,1.13409],[45642,1.13478],[45649,1.13991],[45656,1.14331],[45663,1.15313],
  [45670,1.16717],[45677,1.18984],[45684,1.19783],[45691,1.19186],[45698,1.18993],[45705,1.19121],[45712,1.18952],[45719,1.18265],
  [45726,1.16833],[45733,1.15],[45740,1.14118],[45747,1.14077],[45754,1.14166],[45761,1.11972],[45768,1.10265],[45775,1.09456],
  [45782,1.08968],[45789,1.0803],[45796,1.07903],[45803,1.07947],[45810,1.07661],[45817,1.07369],[45824,1.07864],[45831,1.10877],
  [45838,1.12904],[45845,1.12293],[45852,1.12822],[45859,1.13475],[45866,1.13746],[45873,1.13453],[45880,1.12785],[45887,1.11987],
  [45894,1.11447],[45901,1.11366],[45908,1.1155],[45915,1.11639],[45922,1.11788],[45929,1.11738],[45936,1.11852],[45943,1.11194],
  [45950,1.10542],[45957,1.10362],[45964,1.11512],[45971,1.12892],[45978,1.14398],[45985,1.1545],[45992,1.15051],[45999,1.13885],
  [46006,1.12594],[46013,1.10804],[46020,1.09791],[46027,1.09593],[46034,1.09449],[46041,1.09758],[46048,1.10431],[46055,1.11085],
  [46062,1.11799],[46069,1.12205],[46076,1.12717],[46083,1.14201],[46090,1.31089],[46097,1.46901],[46104,1.56371],[46111,1.61551],
  [46118,1.64825],[46125,1.7134],[46132,1.64335],[46139,1.57025],[46146,1.57717],[46153,1.56169],[46160,1.53204],[46167,1.53272],
  [46174,1.49901],[46181,1.46846],[46188,1.44772],[46195,1.39862],[46202,1.36682],[46209,1.28633],[46216,1.2802],[46223,1.34085],
  [46230,1.42336],[46237,1.48257],[46244,1.50543],
];

const DEFAULT_PRICE_SERIES = PRICE_SERIES_RAW.map(([date, price]) => ({ date, price })).sort((a, b) => a.date - b.date);

/** Aktywna seria cenowa — startuje jako wbudowany domyślny zestaw, może zostać
 *  rozszerzona/nadpisana w trakcie działania aplikacji przez loadPriceSeries()
 *  (np. po wgraniu świeższego pliku Ministerstwa na stronie /korekty-paliwowe
 *  lub po wczytaniu wierszy z tabeli Supabase `fuel_price_series`). */
let ACTIVE_PRICE_SERIES = DEFAULT_PRICE_SERIES;

/** Dokłada/nadpisuje punkty ceny w aktywnej serii (nowsze dane wygrywają przy
 *  tej samej dacie) i zwraca liczbę unikalnych tygodni w wynikowej serii. */
export function loadPriceSeries(points: { date: number; price: number }[]): number {
  const map = new Map<number, number>();
  for (const p of DEFAULT_PRICE_SERIES) map.set(p.date, p.price);
  for (const p of ACTIVE_PRICE_SERIES) map.set(p.date, p.price);
  for (const p of points) if (typeof p.price === "number" && !isNaN(p.price)) map.set(p.date, p.price);
  ACTIVE_PRICE_SERIES = Array.from(map, ([date, price]) => ({ date, price })).sort((a, b) => a.date - b.date);
  return ACTIVE_PRICE_SERIES.length;
}

/** Ostatnia data (serial Excela), dla której aktywna seria ma opublikowaną cenę. */
export function getPriceSeriesLastDate(): number {
  return ACTIVE_PRICE_SERIES[ACTIVE_PRICE_SERIES.length - 1].date;
}

/** Filtruje/normalizuje surowe wiersze [FECHA, Pmed MMA>=7,5t, ...] wyciągnięte
 *  z arkusza "PRECIOS DE REFERENCIA" oficjalnego pliku Ministerstwa — odrzuca
 *  puste/jeszcze nieopublikowane przyszłe tygodnie (komórka z ceną to wtedy
 *  pusty string, nie liczba). */
export function parseWeeklyPriceRows(rows: unknown[][]): { date: number; price: number }[] {
  const out: { date: number; price: number }[] = [];
  for (const r of rows) {
    const date = r[0], price = r[1];
    if (typeof date === "number" && typeof price === "number" && !isNaN(price)) out.push({ date, price });
  }
  return out;
}

export function excelSerialToIso(n: number): string {
  return new Date(Math.round((n - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
}

/** Konwersja daty ISO (YYYY-MM-DD) na serial Excela — odwrotność excelSerialToIso. */
export function isoToExcelSerial(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

/** Najbliższa data z serii tygodniowej >= data docelowa (tak samo jak oficjalny
 *  kalkulator rządowy dopasowuje datę do tygodnia). Zwraca null, jeśli data
 *  wykracza poza ostatni opublikowany tydzień. */
function priceOnOrAfter(dateSerial: number): number | null {
  for (const p of ACTIVE_PRICE_SERIES) if (p.date >= dateSerial) return p.price;
  return null;
}

export const FUEL_REVISION_THRESHOLD_PCT = 5;

// Współczynniki wg wzorów a)-d) — Orden FOM/1882/2012, warianty wagowe pojazdu
export type VehicleWeightClass = "ge20000" | "35to20000" | "construction" | "le3500";

// Wartości potwierdzone wprost z arkusza `COEFIC "C" VARIACIÓN PRECIOS`
// oficjalnego pliku Ministerstwa (preciogasoleosemanalweb_*.xlsx) — kolumny
// A)/B)/C)/D) tej tabeli odpowiadają dokładnie czterem klasom wagowym z
// Orden FOM/1882/2012, po aktualizacji Real Decreto-ley 9/2026 (16.04.2026,
// obowiązuje nadal po RDL 18/2026 z 01.07.2026 — zmienił się tylko wybór
// ceny referencyjnej dla pojazdów < 7,5 t, nie same wartości współczynnika
// dla klasy A, którą stosuje cała flota B&M).
export const FUEL_COEFFICIENTS: Record<VehicleWeightClass, number> = {
  ge20000: 0.40,       // A) MMA >= 20 000 kg, poza budowlanymi
  "35to20000": 0.30,   // B) 3 500 kg < MMA < 20 000 kg, poza budowlanymi
  construction: 0.30,  // C) pojazdy budowlane MMA > 3 500 kg
  le3500: 0.20,        // D) MMA <= 3 500 kg
};

export interface FuelCorrectionResult {
  g: number | null;          // % wariancji ON, null = brak opublikowanej ceny dla jednej z dat
  thresholdMet: boolean;     // |g| >= 5%
  deltaP: number | null;     // EUR — kwota korekty (dodatnia = dopłata, ujemna = zwrot)
  p0: number | null;         // cena referencyjna €/L w tygodniu zawarcia umowy
  p1: number | null;         // cena referencyjna €/L w tygodniu realizacji transportu
}

/** Liczy korektę paliwową dla jednego zlecenia na podstawie dokładnych dat.
 *  @param contractDate data zawarcia umowy — serial Excela (dni od 1899-12-30)
 *  @param execDate      data realizacji/dostawy — serial Excela
 *  @param priceP        baza (fracht) EUR do przemnożenia przez G × coef
 */
export function calcFuelCorrection(
  contractDate: number,
  execDate: number,
  priceP: number,
  weightClass: VehicleWeightClass = "ge20000"
): FuelCorrectionResult {
  const p0 = priceOnOrAfter(contractDate);
  const p1 = priceOnOrAfter(execDate);
  if (p0 == null || p1 == null) return { g: null, thresholdMet: false, deltaP: null, p0, p1 };
  const g = ((p1 - p0) / p0) * 100;
  const thresholdMet = Math.abs(g) >= FUEL_REVISION_THRESHOLD_PCT;
  const coef = FUEL_COEFFICIENTS[weightClass];
  const deltaP = thresholdMet ? (g * priceP * coef) / 100 : 0;
  return { g, thresholdMet, deltaP, p0, p1 };
}
