"use client";

import { useMemo } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";

type ContactStatus = "prospekt" | "w_negocjacji" | "aktywny" | "stracony";

interface MapContact {
  id: string;
  company_name: string;
  status: ContactStatus;
  city: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

const STATUS_LABELS: Record<ContactStatus, string> = {
  prospekt: "Prospekt",
  w_negocjacji: "W negocjacji",
  aktywny: "Aktywny",
  stracony: "Stracony",
};

const STATUS_DOT: Record<ContactStatus, string> = {
  prospekt: "#64748b",
  w_negocjacji: "#d97706",
  aktywny: "#059669",
  stracony: "#dc2626",
};

// Środek Polski — sensowny domyślny widok, gdy nie ma jeszcze żadnych pinezek.
const DEFAULT_CENTER: [number, number] = [52.0, 19.0];

export default function CrmMap({
  contacts, onSelect,
}: { contacts: MapContact[]; onSelect: (id: string) => void }) {
  const withCoords = useMemo(() => contacts.filter((c) => c.lat != null && c.lng != null), [contacts]);

  const center: [number, number] = withCoords.length
    ? [withCoords.reduce((s, c) => s + (c.lat as number), 0) / withCoords.length,
       withCoords.reduce((s, c) => s + (c.lng as number), 0) / withCoords.length]
    : DEFAULT_CENTER;

  // Bez @types/leaflet (patrz src/types/leaflet-shim.d.ts) react-leaflet traci typy
  // pól dziedziczonych z leaflet.MapOptions (m.in. center/zoom/radius) — rzutujemy
  // propsy jawnie zamiast instalować typy, których arborist npm nie potrafi rozwiązać
  // w tym repo (niepowiązany, wcześniej istniejący konflikt wersji w es-abstract).
  const mapProps = { center, zoom: withCoords.length ? 5 : 4, style: { height: "100%", width: "100%" } } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const tileProps = {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

  return (
    <div className="rounded-xl overflow-hidden border border-slate-200" style={{ height: "70vh" }}>
      <MapContainer {...mapProps}>
        <TileLayer {...tileProps} />
        {withCoords.map((c) => {
          const markerProps = {
            center: [c.lat as number, c.lng as number],
            radius: 8,
            pathOptions: { color: "#fff", weight: 2, fillColor: STATUS_DOT[c.status], fillOpacity: 0.9 },
          } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
          return (
            <CircleMarker key={c.id} {...markerProps}>
              <Popup>
                <div className="text-sm">
                  <div className="font-semibold">{c.company_name}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{STATUS_LABELS[c.status]}</div>
                  {(c.address || c.city) && <div className="text-xs text-slate-500 mt-1">📍 {c.address || c.city}</div>}
                  <button
                    className="text-xs text-blue-600 hover:underline mt-2"
                    onClick={() => onSelect(c.id)}
                  >
                    Otwórz kontakt →
                  </button>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}
