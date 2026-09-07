"use client";

import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { profitabilityLabel, type CostBreakdown as CB } from "@/lib/calculator";

interface Props {
  result: CB;
  freightEur: number;
  distanceKm: number;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  saveError?: string | null;
}

const COLORS = [
  "#3b82f6", // fuel
  "#06b6d4", // adblue
  "#8b5cf6", // idle
  "#f59e0b", // toll
  "#10b981", // driver
  "#ef4444", // service
  "#6366f1", // leasing ciągnik
  "#818cf8", // leasing naczepa
  "#f43f5e", // insurance
];

const fmt = (n: number) =>
  n.toLocaleString("pl-PL", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtEur = (n: number) => `${fmt(n)} EUR`;

export default function CostBreakdown({
  result, freightEur, distanceKm, onSave, saving, saved, saveError,
}: Props) {
  const { label, color } = profitabilityLabel(result.marginPct);

  const costItems = [
    { name: "Paliwo ON",      value: result.fuel,           icon: "⛽" },
    { name: "AdBlue",         value: result.adblue,         icon: "💧" },
    { name: "Bieg jałowy",    value: result.idle,           icon: "🔄" },
    { name: "Autostrady",     value: result.toll,           icon: "🛣️" },
    { name: "Kierowca",       value: result.driver,         icon: "👤" },
    { name: "Serwis",         value: result.service,        icon: "🔧" },
    { name: "Leasing cią.",   value: result.leasing,        icon: "💳" },
    { name: "Leasing nacz.",  value: result.trailerLeasing, icon: "🚛" },
    { name: "Ubezpieczenie",  value: result.insurance,      icon: "🛡️" },
  ];

  const pieData = costItems.map(i => ({ name: i.name, value: i.value }));

  const marginColorClass =
    color === "emerald" ? "text-emerald-600 bg-emerald-50" :
    color === "amber"   ? "text-amber-600 bg-amber-50" :
    color === "orange"  ? "text-orange-600 bg-orange-50" :
    "text-red-600 bg-red-50";

  return (
    <div className="space-y-4">
      {/* ── Margin banner ── */}
      <div className={`rounded-xl p-5 flex items-center justify-between ${marginColorClass}`}>
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide opacity-70">{label}</p>
          <p className="text-3xl font-bold mt-0.5">
            {result.marginEur >= 0 ? "+" : ""}{fmtEur(result.marginEur)}
          </p>
          <p className="text-sm mt-1 opacity-80">
            marża: {result.marginPct.toFixed(1)}%
            &nbsp;·&nbsp;
            min. fracht: {fmtEur(result.minProfitableFreight)}
          </p>
        </div>
        <div className="text-right text-sm opacity-70">
          <p>{fmtEur(freightEur)} fracht</p>
          <p>{fmtEur(result.total)} koszt</p>
          <p className="mt-1 font-medium">{result.costPerKm.toFixed(2)} EUR/km</p>
        </div>
      </div>

      {/* ── Grid: breakdown + chart ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Cost rows */}
        <div className="card space-y-2">
          <h3 className="font-bold text-slate-700 mb-3">Struktura kosztów</h3>
          {costItems.map((item, i) => {
            const pct = result.total > 0 ? (item.value / result.total) * 100 : 0;
            return (
              <div key={item.name} className="flex items-center gap-2">
                <span className="text-base w-5">{item.icon}</span>
                <span className="text-sm text-slate-600 flex-1">{item.name}</span>
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, backgroundColor: COLORS[i] }}
                    />
                  </div>
                  <span className="text-xs text-slate-400 w-8 text-right">
                    {pct.toFixed(0)}%
                  </span>
                  <span className="text-sm font-semibold text-slate-700 w-20 text-right">
                    {fmtEur(item.value)}
                  </span>
                </div>
              </div>
            );
          })}
          <div className="border-t border-slate-200 pt-2 flex justify-between">
            <span className="font-bold text-slate-800">ŁĄCZNIE</span>
            <span className="font-bold text-slate-800">{fmtEur(result.total)}</span>
          </div>
        </div>

        {/* Pie chart */}
        <div className="card">
          <h3 className="font-bold text-slate-700 mb-2">Udział kosztów</h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={90}
                paddingAngle={2}
                dataKey="value"
              >
                {pieData.map((_, index) => (
                  <Cell key={index} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v: number) => [fmtEur(v), ""]}
                contentStyle={{ fontSize: "12px" }}
              />
              <Legend
                wrapperStyle={{ fontSize: "11px" }}
                iconType="circle"
                iconSize={8}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Per-km summary ── */}
      <div className="card grid grid-cols-3 gap-4 text-center">
        <div>
          <p className="text-xs text-slate-500 uppercase font-semibold">Przychód/km</p>
          <p className="text-xl font-bold text-slate-800 mt-1">
            {result.revenuePerKm.toFixed(2)} <span className="text-sm font-normal">EUR</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 uppercase font-semibold">Koszt/km</p>
          <p className="text-xl font-bold text-slate-800 mt-1">
            {result.costPerKm.toFixed(2)} <span className="text-sm font-normal">EUR</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 uppercase font-semibold">Marża/km</p>
          <p className={`text-xl font-bold mt-1 ${result.marginEur >= 0 ? "text-emerald-600" : "text-red-600"}`}>
            {(result.revenuePerKm - result.costPerKm).toFixed(2)}{" "}
            <span className="text-sm font-normal">EUR</span>
          </p>
        </div>
      </div>

      {/* ── Save button ── */}
      <div className="flex flex-col items-end gap-1.5">
        <button
          onClick={onSave}
          disabled={saving || saved}
          className="btn-primary"
        >
          {saved ? "✓ Zapisano" : saving ? "Zapisuję..." : "Zapisz kalkulację"}
        </button>
        {saveError && (
          <p className="text-xs text-red-600 max-w-xs text-right">
            Błąd zapisu: {saveError}
          </p>
        )}
      </div>
    </div>
  );
}
