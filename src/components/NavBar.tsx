"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Mode = "transport" | "serwis";
type NavLink = { href: string; label: string };
type NavGroup = { key: string; label: string; links: NavLink[] };

// ── Linki Transport, pogrupowane wg funkcji (21 linków w jednym rzędzie
// było za dużo, żeby cokolwiek szybko znaleźć) ─────────────────────────
const TRANSPORT_GROUPS: NavGroup[] = [
  {
    key: "trasy", label: "Trasy", links: [
      { href: "/kalkulator", label: "Kalkulator" },
      { href: "/dyspozytorzy", label: "Dyspozytorzy" },
      { href: "/analiza", label: "Analiza" },
      { href: "/history", label: "Historia" },
      { href: "/korekty-paliwowe", label: "Korekty ⛽" },
    ],
  },
  {
    key: "flota", label: "Flota", links: [
      { href: "/fleet", label: "Flota" },
      { href: "/fms", label: "FMS" },
      { href: "/serwis", label: "Serwis" },
      { href: "/serwis/zamowienia", label: "Zamówienia części" },
      { href: "/opony", label: "Opony" },
      { href: "/kola", label: "Kółka" },
      { href: "/checklista", label: "Checklista" },
      { href: "/ubezpieczenia", label: "Ubezpieczenia" },
    ],
  },
  {
    key: "finanse", label: "Finanse", links: [
      { href: "/budzet", label: "Budżet" },
      { href: "/platnosci", label: "Płatności 💰" },
      { href: "/windykacja", label: "Windykacja" },
      { href: "/akceptacje", label: "Akceptacje" },
      { href: "/kondycja-finansowa", label: "Kondycja 🩺" },
    ],
  },
  {
    key: "sprzedaz", label: "Sprzedaż", links: [
      { href: "/crm", label: "CRM" },
      { href: "/czesci", label: "Części" },
    ],
  },
  {
    key: "narzedzia", label: "Narzędzia", links: [
      { href: "/import", label: "Import" },
      { href: "/konfiguracja", label: "⚙️ Konfiguracja" },
    ],
  },
];

// ── Linki Serwis (ograniczony dostęp dla warsztatu) — zostają płaskie,
// to tylko 4 pozycje, grupowanie nie ma tu sensu ─────────────────────
const SERWIS_LINKS: NavLink[] = [
  { href: "/serwis",        label: "Serwis" },
  { href: "/serwis/zamowienia", label: "Zamówienia części" },
  { href: "/opony",         label: "Opony" },
  { href: "/checklista",    label: "Checklista" },
  { href: "/konfiguracja",  label: "⚙️" },
];

export default function NavBar() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [mounted, setMounted] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem("hbm_mode") as Mode | null;
    setMode(stored);
  }, []);

  // Nasłuchuj zmian localStorage (np. inny tab)
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === "hbm_mode") {
        setMode(e.newValue as Mode | null);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Re-odczytaj tryb po nawigacji z ekranu powitalnego (fix: świeża sesja)
  useEffect(() => {
    if (pathname && pathname !== "/") {
      const stored = localStorage.getItem("hbm_mode") as Mode | null;
      setMode(stored);
    }
    setOpenGroup(null);
  }, [pathname]);

  // Zamknij rozwinięte menu po kliknięciu poza nim
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenGroup(null);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  // Nie renderuj nav na ekranie powitalnym "/"
  if (!mounted || pathname === "/") return null;

  if (mode === "serwis") {
    return (
      <nav className="flex items-center gap-1 flex-wrap">
        {SERWIS_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              pathname === link.href
                ? "bg-blue-900 text-white"
                : "text-blue-100 hover:text-white hover:bg-blue-800"
            }`}
          >
            {link.label}
          </Link>
        ))}
        <ModeSwitcher mode={mode} />
      </nav>
    );
  }

  return (
    <nav ref={navRef} className="flex items-center gap-1 flex-wrap relative">
      {TRANSPORT_GROUPS.map((group) => {
        const groupActive = group.links.some((l) => l.href === pathname);
        const isOpen = openGroup === group.key;
        return (
          <div key={group.key} className="relative">
            <button
              type="button"
              onClick={() => setOpenGroup(isOpen ? null : group.key)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                groupActive || isOpen
                  ? "bg-blue-900 text-white"
                  : "text-blue-100 hover:text-white hover:bg-blue-800"
              }`}
            >
              {group.label}
              <span className={`text-[10px] transition-transform ${isOpen ? "rotate-180" : ""}`}>▾</span>
            </button>
            {isOpen && (
              <div className="absolute left-0 top-full mt-1 min-w-[180px] bg-white rounded-lg shadow-lg border border-slate-200 py-1.5 z-50">
                {group.links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setOpenGroup(null)}
                    className={`block px-4 py-2 text-sm ${
                      pathname === link.href
                        ? "bg-blue-50 text-blue-900 font-semibold"
                        : "text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Zarząd — poza grupami, zawsze widoczny, żółty */}
      <Link
        href="/zarzad"
        className={`px-3 py-1.5 rounded-md text-sm font-bold transition-colors ${
          pathname === "/zarzad"
            ? "bg-yellow-300 text-[#1F3864]"
            : "bg-yellow-400 text-[#1F3864] hover:bg-yellow-300"
        }`}
      >
        Zarząd
      </Link>

      <ModeSwitcher mode={mode} />
    </nav>
  );
}

function ModeSwitcher({ mode }: { mode: Mode | null }) {
  return (
    <>
      <span className="text-blue-500 mx-1 select-none">|</span>
      <Link
        href="/"
        onClick={() => localStorage.removeItem("hbm_mode")}
        className="px-2 py-1 rounded-md text-xs font-medium text-blue-300 hover:text-white hover:bg-blue-800 transition-colors"
        title="Zmień tryb (Transport / Serwis)"
      >
        ⇄&nbsp;{mode === "transport" ? "Transport" : mode === "serwis" ? "Serwis" : "Tryb"}
      </Link>
    </>
  );
}
