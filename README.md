# TruckCalc HBM — Kalkulator Rentowności Tras

System kalkulacji kosztów transportu dla zarządu. Zbudowany na Next.js 14 + Supabase + Vercel.

## Uruchomienie lokalne

```bash
# 1. Zainstaluj zależności
npm install

# 2. Skopiuj zmienne środowiskowe
cp .env.local.example .env.local
# → uzupełnij SUPABASE_URL i klucze z dashboardu Supabase

# 3. Uruchom dev server
npm run dev
# → http://localhost:3000
```

## Baza danych (Supabase)

```bash
# Wklej zawartość supabase/migrations/001_init.sql
# do Supabase SQL Editor → Run
# lub użyj Supabase CLI:
supabase db push
```

## Deploy (Vercel)

### Źródło kontaktów w CRM

Przed wdrożeniem interfejsu z filtrem „Źródło” zastosuj migrację
`supabase/migrations/027_crm_contact_source.sql` w bazie używanej przez aplikację.
Migracja dodaje źródło niezależne od statusu: `manual` (domyślne dla kontaktów
dodawanych ręcznie) i `website` (automatycznie dla formularza B&M).
Wcześniejsze zgłoszenia ze strony rozpoznaje po zapisach `crm_website_receipts`
lub dokładnym nagłówku notatki integracji. Pozostałe kontakty otrzymują `manual`.
Zmiana statusu i edycja danych kontaktu zachowują źródło.

Po wdrożeniu sprawdź filtr „Źródło” wraz ze statusem w widoku listy i mapy,
etykietę zgłoszenia ze strony oraz źródło w szczegółach kontaktu.

1. Połącz repo GitHub z Vercel
2. Dodaj zmienne środowiskowe w Vercel Dashboard:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Deploy automatyczny przy push do `main`

## Struktura kosztów (dane rzeczywiste floty)

| Parametr | Wartość | Źródło |
|---|---|---|
| Spalanie średnie | 29.62 l/100km | Trimble FMS, 67 ciągników |
| Koszt kierowcy | 0.643 EUR/km | 3 328 285 EUR / 5 180 419 km |
| Serwis nowy | 0.009 EUR/km | MAN TGX 2023-2024 |
| Serwis stary | 0.020 EUR/km | MAN 2018-2019, DAF XF 2019 |
| Leasing nowy | 733 EUR/mies. | ~8 800 EUR/rok |
| Leasing stary | 521 EUR/mies. | ~6 250 EUR/rok |
| Bieg jałowy | 9.22% kosztu paliwa | wydatki.xls / Trimble |

## Widoki

- `/` — Kalkulator trasy (formularz + wykres kosztów)
- `/history` — Historia zapisanych kalkulacji
- `/fleet` — Lista pojazdów z licznikami i leasingiem
- `/import` — Import XLS/XLSX (kartoteka pojazdów, wydatki)
