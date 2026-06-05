"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Asset = {
  symbol: string;
  label: string;
  base: string;
  accent: string;
};

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Ticker = {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  volume: number;
};

type WsTickerPayload = {
  e: string;
  s: string;
  c: string;
  o: string;
  h: string;
  l: string;
  v: string;
};

type WsKlinePayload = {
  e: string;
  s: string;
  k: {
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
  };
};

type StreamMessage = {
  stream?: string;
  data?: WsTickerPayload | WsKlinePayload;
};

const ASSETS: Asset[] = [
  { symbol: "BTCUSDT", label: "Bitcoin", base: "BTC", accent: "#f59e0b" },
  { symbol: "ETHUSDT", label: "Ethereum", base: "ETH", accent: "#22c55e" },
  { symbol: "SOLUSDT", label: "Solana", base: "SOL", accent: "#06b6d4" },
  { symbol: "BNBUSDT", label: "BNB", base: "BNB", accent: "#a855f7" },
  { symbol: "XRPUSDT", label: "XRP", base: "XRP", accent: "#ef4444" },
];

const INTERVALS = [
  { label: "1m", value: "1m" },
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "1h", value: "1h" },
] as const;

const REST_BASE = "https://api.binance.com";
const WS_BASE = "wss://stream.binance.com:9443/stream";

const formatUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

function isTickerPayload(data: StreamMessage["data"]): data is WsTickerPayload {
  return Boolean(data && data.e === "24hrTicker");
}

function isKlinePayload(data: StreamMessage["data"]): data is WsKlinePayload {
  return Boolean(data && data.e === "kline");
}

function candleFromKlineRow(row: unknown[]): Candle {
  return {
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

function tickerFromPayload(payload: WsTickerPayload): Ticker {
  const price = Number(payload.c);
  const open = Number(payload.o);

  return {
    symbol: payload.s,
    price,
    change: price - open,
    changePercent: open > 0 ? ((price - open) / open) * 100 : 0,
    high: Number(payload.h),
    low: Number(payload.l),
    volume: Number(payload.v),
  };
}

function candleFromPayload(payload: WsKlinePayload): Candle {
  return {
    time: payload.k.t,
    open: Number(payload.k.o),
    high: Number(payload.k.h),
    low: Number(payload.k.l),
    close: Number(payload.k.c),
    volume: Number(payload.k.v),
  };
}

function upsertCandle(candles: Candle[], next: Candle) {
  const existingIndex = candles.findIndex((candle) => candle.time === next.time);

  if (existingIndex === -1) {
    return [...candles, next].slice(-96);
  }

  return candles.map((candle, index) => (index === existingIndex ? next : candle));
}

function buildChartPath(points: Candle[], width: number, height: number) {
  if (points.length < 2) {
    return "";
  }

  const closes = points.map((point) => point.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = Math.max(max - min, max * 0.002);

  return points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((point.close - min) / range) * height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function buildAreaPath(linePath: string, width: number, height: number) {
  if (!linePath) {
    return "";
  }

  return `${linePath} L ${width} ${height} L 0 ${height} Z`;
}

function pct(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export default function CryptoTerminal() {
  const [selectedSymbol, setSelectedSymbol] = useState(ASSETS[0].symbol);
  const [interval, setIntervalValue] = useState<(typeof INTERVALS)[number]["value"]>("1m");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [tickers, setTickers] = useState<Record<string, Ticker>>({});
  const [status, setStatus] = useState<"connecting" | "live" | "degraded">("connecting");
  const [error, setError] = useState<string>("");
  const reconnectTimer = useRef<number | null>(null);

  const selectedAsset = ASSETS.find((asset) => asset.symbol === selectedSymbol) ?? ASSETS[0];
  const selectedTicker = tickers[selectedSymbol];
  const latestCandle = candles.at(-1);
  const previousCandle = candles.at(-2);
  const livePrice = selectedTicker?.price ?? latestCandle?.close ?? 0;
  const shortMove =
    latestCandle && previousCandle && previousCandle.close > 0
      ? ((latestCandle.close - previousCandle.close) / previousCandle.close) * 100
      : 0;
  const chartTrend = candles.length > 1 && candles.at(-1)!.close >= candles[0].open;
  const chartWidth = 900;
  const chartHeight = 320;
  const chartPath = useMemo(
    () => buildChartPath(candles, chartWidth, chartHeight),
    [candles],
  );
  const areaPath = useMemo(
    () => buildAreaPath(chartPath, chartWidth, chartHeight),
    [chartPath],
  );
  const priceRange = useMemo(() => {
    if (!candles.length) {
      return { high: 0, low: 0 };
    }

    return {
      high: Math.max(...candles.map((candle) => candle.high)),
      low: Math.min(...candles.map((candle) => candle.low)),
    };
  }, [candles]);

  useEffect(() => {
    let cancelled = false;

    async function loadCandles() {
      setStatus((current) => (current === "live" ? current : "connecting"));
      setError("");

      try {
        const response = await fetch(
          `${REST_BASE}/api/v3/klines?symbol=${selectedSymbol}&interval=${interval}&limit=96`,
        );

        if (!response.ok) {
          throw new Error(`Binance REST responded ${response.status}`);
        }

        const rows = (await response.json()) as unknown[][];

        if (!cancelled) {
          setCandles(rows.map(candleFromKlineRow));
        }
      } catch {
        if (!cancelled) {
          setCandles([]);
          setStatus("degraded");
          setError("Historical candles are unavailable. Live ticks will resume when the exchange is reachable.");
        }
      }
    }

    loadCandles();

    return () => {
      cancelled = true;
    };
  }, [selectedSymbol, interval]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closedByEffect = false;

    function connect() {
      const streams = [
        ...ASSETS.map((asset) => `${asset.symbol.toLowerCase()}@ticker`),
        `${selectedSymbol.toLowerCase()}@kline_${interval}`,
      ].join("/");

      setStatus("connecting");
      socket = new WebSocket(`${WS_BASE}?streams=${streams}`);

      socket.addEventListener("open", () => {
        setStatus("live");
        setError("");
      });

      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data as string) as StreamMessage;
          const payload = message.data;

          if (isTickerPayload(payload)) {
            setTickers((current) => ({
              ...current,
              [payload.s]: tickerFromPayload(payload),
            }));
          }

          if (isKlinePayload(payload) && payload.s === selectedSymbol) {
            setCandles((current) => upsertCandle(current, candleFromPayload(payload)));
          }
        } catch {
          setStatus("degraded");
          setError("A live market message could not be parsed.");
        }
      });

      socket.addEventListener("close", () => {
        if (closedByEffect) {
          return;
        }

        setStatus("degraded");
        setError("Live feed disconnected. Reconnecting to the exchange stream.");
        reconnectTimer.current = window.setTimeout(connect, 2500);
      });

      socket.addEventListener("error", () => {
        setStatus("degraded");
        setError("Live exchange stream is currently unavailable.");
        socket?.close();
      });
    }

    connect();

    return () => {
      closedByEffect = true;
      socket?.close();

      if (reconnectTimer.current) {
        window.clearTimeout(reconnectTimer.current);
      }
    };
  }, [selectedSymbol, interval]);

  return (
    <main className="min-h-screen bg-[#f5f7fa] text-[#172026]">
      <section className="border-b border-[#d9e0e7] bg-white">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#64748b]">
                Realtime Crypto Markets
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-normal text-[#111827] sm:text-4xl">
                Atlas Exchange Desk
              </h1>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div
                className={`h-2.5 w-2.5 rounded-full ${
                  status === "live"
                    ? "bg-[#16a34a]"
                    : status === "connecting"
                      ? "bg-[#d97706]"
                      : "bg-[#dc2626]"
                }`}
              />
              <span className="text-sm font-medium text-[#334155]">
                {status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Degraded"}
              </span>
              <span className="rounded border border-[#d9e0e7] bg-[#f8fafc] px-3 py-1.5 font-mono text-sm text-[#334155]">
                Binance spot
              </span>
            </div>
          </div>

          {error ? (
            <div className="rounded border border-[#f2c94c] bg-[#fff8df] px-4 py-3 text-sm text-[#735c0f]">
              {error}
            </div>
          ) : null}
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:px-8">
        <aside className="space-y-4">
          <div className="rounded border border-[#d9e0e7] bg-white">
            <div className="border-b border-[#e5eaf0] px-4 py-3">
              <h2 className="text-sm font-semibold text-[#111827]">Watchlist</h2>
            </div>
            <div className="divide-y divide-[#edf1f5]">
              {ASSETS.map((asset) => {
                const ticker = tickers[asset.symbol];
                const isActive = selectedSymbol === asset.symbol;
                const isUp = (ticker?.changePercent ?? 0) >= 0;

                return (
                  <button
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${
                      isActive ? "bg-[#eef6ff]" : "bg-white hover:bg-[#f8fafc]"
                    }`}
                    key={asset.symbol}
                    onClick={() => setSelectedSymbol(asset.symbol)}
                    type="button"
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded border text-xs font-bold text-white"
                      style={{ backgroundColor: asset.accent, borderColor: asset.accent }}
                    >
                      {asset.base}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-[#111827]">
                        {asset.label}
                      </span>
                      <span className="block font-mono text-xs text-[#64748b]">{asset.symbol}</span>
                    </span>
                    <span className="text-right">
                      <span className="block font-mono text-sm font-semibold text-[#111827]">
                        {ticker ? formatUsd.format(ticker.price) : "..."}
                      </span>
                      <span className={`block text-xs font-semibold ${isUp ? "text-[#15803d]" : "text-[#b91c1c]"}`}>
                        {ticker ? pct(ticker.changePercent) : "0.00%"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded border border-[#d9e0e7] bg-white p-4">
            <h2 className="text-sm font-semibold text-[#111827]">Risk Snapshot</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-[#64748b]">24h high</dt>
                <dd className="font-mono font-semibold text-[#111827]">
                  {selectedTicker ? formatUsd.format(selectedTicker.high) : "..."}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[#64748b]">24h low</dt>
                <dd className="font-mono font-semibold text-[#111827]">
                  {selectedTicker ? formatUsd.format(selectedTicker.low) : "..."}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[#64748b]">24h volume</dt>
                <dd className="font-mono font-semibold text-[#111827]">
                  {selectedTicker ? compactNumber.format(selectedTicker.volume) : "..."}
                </dd>
              </div>
            </dl>
          </div>
        </aside>

        <div className="space-y-4">
          <div className="rounded border border-[#d9e0e7] bg-white">
            <div className="flex flex-col gap-4 border-b border-[#e5eaf0] px-4 py-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: selectedAsset.accent }}
                  />
                  <h2 className="text-xl font-semibold text-[#111827]">
                    {selectedAsset.label} / USDT
                  </h2>
                </div>
                <p className="mt-1 font-mono text-sm text-[#64748b]">{selectedSymbol}</p>
              </div>

              <div className="flex items-center gap-2 rounded border border-[#d9e0e7] bg-[#f8fafc] p-1">
                {INTERVALS.map((item) => (
                  <button
                    className={`h-9 min-w-12 rounded px-3 text-sm font-semibold transition ${
                      interval === item.value
                        ? "bg-white text-[#111827] shadow-sm"
                        : "text-[#64748b] hover:text-[#111827]"
                    }`}
                    key={item.value}
                    onClick={() => setIntervalValue(item.value)}
                    type="button"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-4 border-b border-[#e5eaf0] px-4 py-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Last price" value={livePrice ? formatUsd.format(livePrice) : "..."} />
              <Metric
                intent={(selectedTicker?.changePercent ?? 0) >= 0 ? "up" : "down"}
                label="24h change"
                value={selectedTicker ? `${formatUsd.format(selectedTicker.change)} ${pct(selectedTicker.changePercent)}` : "..."}
              />
              <Metric
                intent={shortMove >= 0 ? "up" : "down"}
                label={`${interval} candle`}
                value={candles.length ? pct(shortMove) : "..."}
              />
              <Metric
                label="Chart range"
                value={
                  priceRange.high
                    ? `${compactUsd.format(priceRange.low)} - ${compactUsd.format(priceRange.high)}`
                    : "..."
                }
              />
            </div>

            <div className="p-4">
              <div className="relative min-h-[360px] overflow-hidden rounded border border-[#e5eaf0] bg-[#fbfcfe]">
                {candles.length ? (
                  <svg
                    aria-label={`${selectedAsset.label} realtime price chart`}
                    className="h-full min-h-[360px] w-full"
                    preserveAspectRatio="none"
                    role="img"
                    viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                  >
                    <defs>
                      <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
                        <stop
                          offset="0%"
                          stopColor={chartTrend ? "#16a34a" : "#dc2626"}
                          stopOpacity="0.22"
                        />
                        <stop
                          offset="100%"
                          stopColor={chartTrend ? "#16a34a" : "#dc2626"}
                          stopOpacity="0"
                        />
                      </linearGradient>
                    </defs>
                    {[0, 1, 2, 3].map((line) => (
                      <line
                        key={line}
                        stroke="#e5eaf0"
                        strokeWidth="1"
                        x1="0"
                        x2={chartWidth}
                        y1={(line / 3) * chartHeight}
                        y2={(line / 3) * chartHeight}
                      />
                    ))}
                    <path d={areaPath} fill="url(#chart-fill)" />
                    <path
                      d={chartPath}
                      fill="none"
                      stroke={chartTrend ? "#16a34a" : "#dc2626"}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="3"
                    />
                  </svg>
                ) : (
                  <div className="flex min-h-[360px] items-center justify-center px-6 text-center">
                    <div>
                      <p className="text-base font-semibold text-[#111827]">Waiting for market data</p>
                      <p className="mt-2 max-w-md text-sm leading-6 text-[#64748b]">
                        The terminal is connected directly to public exchange endpoints. Check network
                        access if this state persists.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <InfoPanel
              title="Execution View"
              body="Realtime spot data, interval switching, and resilient reconnects are handled in the browser without exposing server secrets."
            />
            <InfoPanel
              title="Operational State"
              body="Connection status and degraded notices stay visible so production operators can distinguish stale data from live markets."
            />
            <InfoPanel
              title="Deployment Ready"
              body="No private keys, no server-side exchange dependency, and no install-time chart package risk. Add authenticated trading behind server functions when needed."
            />
          </div>
        </div>
      </section>
    </main>
  );
}

function Metric({
  label,
  value,
  intent,
}: {
  label: string;
  value: string;
  intent?: "up" | "down";
}) {
  return (
    <div className="rounded border border-[#e5eaf0] bg-[#fbfcfe] p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#64748b]">{label}</p>
      <p
        className={`mt-2 break-words font-mono text-lg font-semibold ${
          intent === "up" ? "text-[#15803d]" : intent === "down" ? "text-[#b91c1c]" : "text-[#111827]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function InfoPanel({ title, body }: { title: string; body: string }) {
  return (
    <section className="rounded border border-[#d9e0e7] bg-white p-4">
      <h2 className="text-sm font-semibold text-[#111827]">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-[#64748b]">{body}</p>
    </section>
  );
}
