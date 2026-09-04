"use client";

/**
 * Alerts (§26).
 *
 * Shows configured rules and fired events. Channels the operator has not set up
 * are labelled as such on the rule itself, so a user cannot believe an alert is
 * reaching them when it is not.
 */

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Input, Select, Spinner } from "@/components/ui";
import { PageShell } from "@/components/AppNav";

interface AlertRow {
  id: string;
  symbol: string;
  kind: string;
  value: number | null;
  enabled: boolean;
  channels: string[];
  triggerCount: number;
  lastTriggeredAt: number | null;
}

interface EventRow {
  id: string;
  symbol: string;
  kind: string;
  message: string;
  severity: string;
  triggeredAt: number;
  acknowledged: boolean;
}

/** Kinds that compare against a number; the rest ignore the value field. */
const NEEDS_VALUE = new Set([
  "price_above",
  "price_below",
  "percent_change",
  "rsi_above",
  "rsi_below",
  "volume_spike",
  "volatility_above",
]);

export function AlertsClient() {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [symbol, setSymbol] = useState("AAPL");
  const [kind, setKind] = useState("price_above");
  const [value, setValue] = useState("");

  const load = useCallback(async () => {
    try {
      const [alertsRes, eventsRes] = await Promise.all([
        fetch("/api/alerts"),
        fetch("/api/alerts/events?limit=50"),
      ]);
      const alertsData = (await alertsRes.json().catch(() => ({}))) as {
        alerts?: AlertRow[];
        kinds?: Record<string, string>;
      };
      const eventsData = (await eventsRes.json().catch(() => ({}))) as { events?: EventRow[] };
      setAlerts(alertsData.alerts ?? []);
      setKinds(alertsData.kinds ?? {});
      setEvents(eventsData.events ?? []);
    } catch {
      setError("Could not load alerts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    setError(null);
    const numeric = Number(value);
    const body: Record<string, unknown> = { symbol: symbol.trim().toUpperCase(), kind };
    if (NEEDS_VALUE.has(kind)) {
      if (!Number.isFinite(numeric)) {
        setError("This alert kind needs a numeric threshold.");
        return;
      }
      body.value = numeric;
    }
    const res = await fetch("/api/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Could not create the alert.");
      return;
    }
    setValue("");
    await load();
  }, [symbol, kind, value, load]);

  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      await fetch("/api/alerts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, enabled }),
      });
      await load();
    },
    [load]
  );

  const remove = useCallback(
    async (id: string) => {
      await fetch(`/api/alerts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    },
    [load]
  );

  const acknowledge = useCallback(async () => {
    const ids = events.filter((e) => !e.acknowledged).map((e) => e.id);
    if (ids.length === 0) return;
    await fetch("/api/alerts/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    await load();
  }, [events, load]);

  const unacknowledged = events.filter((e) => !e.acknowledged).length;

  return (
    <PageShell
      title="Alerts"
      subtitle="Edge-triggered: a rule fires on the crossing, not while a condition stays true."
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card title="New alert" padding="sm">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
              Symbol
            </label>
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} className="w-28" />
          </div>
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
              Condition
            </label>
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(kinds).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          {NEEDS_VALUE.has(kind) ? (
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
                Threshold
              </label>
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                inputMode="decimal"
                className="w-28"
              />
            </div>
          ) : null}
          <Button onClick={() => void create()}>Add alert</Button>
        </div>
        <p className="mt-2 text-[10px] text-muted">
          Only the browser channel is delivered without extra setup. Email, Telegram and push report
          as undelivered until their credentials are configured.
        </p>
      </Card>

      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <>
          <Card title={`Rules (${alerts.length})`} padding="none">
            {alerts.length === 0 ? (
              <p className="p-4 text-xs text-muted">No alerts configured.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-3 py-2">Symbol</th>
                      <th className="px-3 py-2">Condition</th>
                      <th className="px-3 py-2 text-right">Threshold</th>
                      <th className="px-3 py-2 text-right">Fired</th>
                      <th className="px-3 py-2">Channels</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.map((row) => (
                      <tr key={row.id} className="border-b border-line/60 last:border-0">
                        <td className="px-3 py-2 font-mono font-semibold">{row.symbol}</td>
                        <td className="px-3 py-2">{kinds[row.kind] ?? row.kind}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {row.value === null ? "—" : row.value}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{row.triggerCount}</td>
                        <td className="px-3 py-2 text-[10px] text-muted">
                          {row.channels.join(", ")}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void toggle(row.id, !row.enabled)}
                            >
                              {row.enabled ? "Disable" : "Enable"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => void remove(row.id)}>
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title={`Fired events${unacknowledged > 0 ? ` — ${unacknowledged} new` : ""}`}
            padding="none"
            action={
              unacknowledged > 0 ? (
                <Button size="sm" variant="secondary" onClick={() => void acknowledge()}>
                  Acknowledge all
                </Button>
              ) : null
            }
          >
            {events.length === 0 ? (
              <p className="p-4 text-xs text-muted">Nothing has fired yet.</p>
            ) : (
              <ul className="divide-y divide-line/60">
                {events.map((event) => (
                  <li key={event.id} className="flex items-start gap-2 px-3 py-2">
                    <Badge
                      variant={
                        event.severity === "critical"
                          ? "danger"
                          : event.severity === "warning"
                            ? "warning"
                            : "info"
                      }
                      size="sm"
                    >
                      {event.severity}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px]">{event.message}</p>
                      <p className="text-[10px] text-muted">
                        {new Date(event.triggeredAt).toLocaleString()}
                      </p>
                    </div>
                    {!event.acknowledged ? (
                      <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </PageShell>
  );
}
