"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Mode = "transport" | "serwis";

// ── Linki Transport (pełny dostęp) ────────────────────────────
const TRANSPORT_LINKS: { href: string; label: string }[] = [
  { href: "/kalkulator",    label: "Kalkulator" },
  { href: "/history",       label: "Historia" },
  { href: "/fleet",         label: "Flota" },
  { href: "/analiza",       label: "Analiza" },
  { href: "/fms",           label: "FMS" },
  { href: "/ubezpieczenia", label: "Ubezpieczenia" },
  { href: "/dyspozytorzy",  label: "Dyspozytorzy" },
  { href: "/crm",           label: "CRM" },
  { href: "/kola",          label: "Kółka" },
  { href: "/serwis",        label: "Serwis" },
  { href: "/opony",         label: "Opony" },
  { href: "/checklista",    label: "Checklista" },
  { href: "/budzet",        label: "Budżet" },
  { href: "/import",        label: "Import" },
  { href: "/konfiguracja",  label: "⚙️" },
];

// ── Linki Serwis (ograniczony dostęp dla warsztatu) ───────────
const SERWIS_LINKS: { href: string; label: string }[] = [
  { href: "/serwis",        label: "Serwis" },
  { href: "/opony",         label: "Opony" },
  { href: "/checklista",    label: "Checklista" },
  { href: "/konfiguracja",  label: "⚙️" },
];

export default function NavBar() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [mounted, setMounted] = useState(false);
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
  }, [pathname]);

  // Nie renderuj nav na ekranie powitalnym "/"
  if (!mounted || pathname === "/") return null;

  const links = mode === "serwis" ? SERWIS_LINKS : TRANSPORT_LINKS;

  return (
    <nav className="flex items-center gap-1 flex-wrap">
      {links.map((link) => (
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

      {/* Zarząd — tylko transport, żółty */}
      {mode === "transport" && (
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
      )}

      {/* Separator + przełącznik trybu */}
      <span className="text-blue-500 mx-1 select-none">|</span>
      <Link
        href="/"
        onClick={() => localStorage.removeItem("hbm_mode")}
        className="px-2 py-1 rounded-md text-xs font-medium text-blue-300 hover:text-white hover:bg-blue-800 transition-colors"
        title="Zmień tryb (Transport / Serwis)"
      >
        ⇄&nbsp;{mode === "transport" ? "Transport" : mode === "serwis" ? "Serwis" : "Tryb"}
      </Link>
    </nav>
  );
}
