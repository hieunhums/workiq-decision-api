/**
 * Web IQ, Microsoft AI's grounding API, for questions about the public web.
 *
 * One call to `sonic` rather than a choice of tools. Sonic blends web results
 * with whatever verticals match the query, so "weather in Singapore" comes back
 * with a forecast, "MSFT stock" with a quote and "latest on X" with news, all
 * in a single round trip of about half a second. Picking the vertical first
 * would cost the model a decision it has no reason to make.
 *
 * Results are asked for as passages capped at a few hundred characters. Left
 * at the default, three pages came back as 29K characters of HTML, which a
 * voice model would pay for in latency and then mostly ignore.
 *
 * Everything that comes back is untrusted page text. It is read aloud or shown,
 * never followed.
 */

const ENDPOINT = "https://api.microsoft.ai/v3/mcp";

export type WebSource = {
  kind: "web" | "news" | "finance" | "weather" | "image" | "video";
  title: string;
  url: string;
  snippet: string;
  /** When the page says it was updated, or when the quote or reading was taken. */
  date: string | null;
  /** Images and videos: a Bing-hosted preview, safe to load on the page. */
  thumbnail?: string;
  width?: number;
  height?: number;
  /** Videos only. */
  publisher?: string;
  length?: string;
  views?: number;
  embed?: string;
};

/** Pictures or videos asked for alongside the search. */
export type Show = "images" | "videos";

type WebAnswer = {
  /** What the model reads. */
  text: string;
  /** What the page shows. */
  sources: WebSource[];
  foundNothing: boolean;
  seconds: number;
};

type Raw = Record<string, unknown>;

export function webConfigured(): boolean {
  return Boolean(process.env.WEBIQ_API_KEY);
}

/**
 * `show` adds Web IQ's images or videos tool, called alongside sonic rather
 * than after it: each is about 0.3s, so together they cost what one does.
 * Media failing never fails the search; the passages are the answer.
 */
export async function searchWeb(query: string, show: Show | null = null): Promise<WebAnswer> {
  const key = process.env.WEBIQ_API_KEY;
  if (!key) throw new Error("WEBIQ_API_KEY is not set.");
  const started = Date.now();
  const region = process.env.USER_COUNTRY || "US";

  const [structured, media] = await Promise.all([
    call(key, "sonic", {
      query,
      region,
      language: "en",
      contentFormat: "passage",
      maxLength: 400,
      maxResultsWeb: 5,
    }),
    show === "images"
      ? call(key, "images", { query, region, maxResults: 8, safeSearch: "strict" }).catch(() => null)
      : show === "videos"
        ? call(key, "videos", { query, region, maxResults: 4, safeSearch: "strict" }).catch(() => null)
        : Promise.resolve(null),
  ]);

  const pictures = [
    ...list(media?.imageResults).map(image),
    ...list(media?.videoResults).map(video),
  ].filter((s): s is WebSource => s !== null);

  const sources = [
    ...list(structured.weatherResults).map(weather),
    ...list(structured.financeResults).map(finance),
    ...english(list(structured.newsResults)).slice(0, 3).map((r) => page(r, "news")),
    ...english(list(structured.webResults)).map((r) => page(r, "web")),
  ].filter((s): s is WebSource => s !== null);

  const all = [...pictures, ...sources];
  const onScreen = show
    ? pictures.length
      ? `${pictures.length} ${show} are now on the user's screen.`
      : `No ${show} were found to show.`
    : "";
  return {
    text: all.length
      ? // Three pictures are enough for the model to say what is shown.
        [onScreen, ...pictures.slice(0, 3).map(render), ...sources.map(render)]
          .filter(Boolean)
          .join("\n\n")
      : "The web search found nothing.",
    sources: all,
    foundNothing: all.length === 0,
    seconds: (Date.now() - started) / 1000,
  };
}

async function call(key: string, name: string, args: Raw): Promise<Raw> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "x-apikey": key,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Web IQ returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    result?: { structuredContent?: Raw; content?: { text?: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  if (payload.error) throw new Error(`Web IQ: ${payload.error.message ?? "error"}`);
  const structured = payload.result?.structuredContent;
  // Web IQ reports bad arguments as ordinary text content, not as an error,
  // so a result with no structured part is the failure signal.
  if (!structured || payload.result?.isError) {
    const said = payload.result?.content?.[0]?.text ?? "no content";
    throw new Error(`Web IQ: ${said.slice(0, 200)}`);
  }
  return structured;
}

/** Only previews Web IQ hosts itself are loaded, never the source site's file. */
function thumbnail(value: unknown): string | undefined {
  try {
    const url = new URL(str(value));
    const host = url.hostname;
    return url.protocol === "https:" && (host === "bing.net" || host.endsWith(".bing.net") || host === "www.bing.com" || host.endsWith(".bing.com"))
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function image(r: Raw): WebSource | null {
  if (str(r.isAdult).toLowerCase() === "true") return null;
  const preview = thumbnail(r.thumbnailUrl);
  const url = str(r.hostPageUrl) || str(r.url);
  if (!preview || !url) return null;
  return {
    kind: "image",
    title: str(r.title) || url,
    url,
    snippet: str(r.caption),
    date: null,
    thumbnail: preview,
    width: Number(r.width) || undefined,
    height: Number(r.height) || undefined,
  };
}

/** Players the page will embed. Anything else opens in a new tab instead. */
const PLAYERS = ["www.youtube.com", "www.youtube-nocookie.com", "player.vimeo.com"];

function video(r: Raw): WebSource | null {
  if (str(r.isAdult).toLowerCase() === "true") return null;
  const url = str(r.url);
  if (!url) return null;
  let embed: string | undefined;
  try {
    const player = new URL(str(r.embeddingUrl));
    if (player.protocol === "https:" && PLAYERS.includes(player.hostname) && str(r.allowHttpsEmbedding).toLowerCase() !== "false") {
      embed = player.toString();
    }
  } catch {
    embed = undefined;
  }
  return {
    kind: "video",
    title: str(r.title) || url,
    url,
    snippet: str(r.description).replace(/\s+/g, " ").slice(0, 240),
    date: str(r.lastUpdatedAt) || null,
    thumbnail: thumbnail(r.thumbnailUrl),
    publisher: str(r.publishedBy) || undefined,
    length: clock(str(r.length)),
    views: Number(r.viewCount) || undefined,
    embed,
  };
}

/** "00:00:44" as "0:44", "01:02:03" as "1:02:03". */
function clock(value: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/^00:/, "").replace(/^0(?=\d)/, "");
  return trimmed || undefined;
}

function list(value: unknown): Raw[] {
  return Array.isArray(value) ? (value as Raw[]) : [];
}

/**
 * Asking for English still lets a German copy of the same page through. It is
 * dropped unless nothing else came back, since a foreign page beats nothing.
 */
function english(results: Raw[]): Raw[] {
  const kept = results.filter((r) => !r.language || str(r.language).startsWith("en"));
  return kept.length ? kept : results;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function page(r: Raw, kind: "web" | "news"): WebSource | null {
  const url = str(r.url);
  if (!url) return null;
  const title = str(r.title) || url;
  let snippet = str(r.content).replace(/\s+/g, " ").trim();
  // Passages open with the page title, which is already shown above them.
  if (snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();
  return {
    kind,
    title,
    url,
    snippet,
    date: str(r.lastUpdatedAt || r.datePublished || r.crawledAt) || null,
  };
}

function weather(r: Raw): WebSource | null {
  const units = (r.units ?? {}) as Raw;
  const t = str(units.temperature) || "\u00b0";
  const current = (r.currentWeather ?? {}) as Raw;
  const days = list(r.forecastedWeather).slice(0, 3);
  const lines: string[] = [];
  if (current.condition) {
    lines.push(
      `Now: ${str(current.condition)}, ${str(current.temperature)}${t} (feels ${str(current.feelsLike)}${t}), humidity ${str(current.humidity)}%.`,
    );
  }
  for (const d of days) {
    lines.push(
      `${str(d.validDate)}: ${str(d.condition)}, ${str(d.temperatureLow)} to ${str(d.temperatureHigh)}${t}, ${str(d.precipitationChance)}% chance of rain.`,
    );
  }
  if (!lines.length) return null;
  return {
    kind: "weather",
    title: `Weather in ${str(r.location) || "the area"}`,
    url: str(r.url),
    snippet: lines.join(" "),
    date: str(current.observedAt) || null,
  };
}

function finance(r: Raw): WebSource | null {
  const data = (r.data ?? {}) as Raw;
  const i = (data.instrument ?? {}) as Raw;
  if (i.price === undefined) return null;
  const change = Number(i.changePercent ?? 0);
  const parts = [
    `${str(i.displayName) || str(r.title)} (${str(i.symbol)}): ${str(i.price)} ${str(i.currency)}`,
    `${change >= 0 ? "up" : "down"} ${Math.abs(Number(i.changeAmount ?? 0)).toFixed(2)} (${Math.abs(change).toFixed(2)}%) on the previous close of ${str(i.pricePreviousClose)}`,
    i.isMarketRegularHours === false ? "market closed" : "market open",
  ];
  if (i.pricePostMarket !== undefined) parts.push(`after hours ${str(i.pricePostMarket)}`);
  if (i.price52WeekLow !== undefined) parts.push(`52-week range ${str(i.price52WeekLow)} to ${str(i.price52WeekHigh)}`);
  return {
    kind: "finance",
    title: str(r.title) || str(i.displayName),
    url: str(r.url),
    snippet: parts.join(", ") + ".",
    date: str(i.lastTradedAt) || null,
  };
}

function render(s: WebSource): string {
  if (s.kind === "image") return `[image] ${s.title}${s.snippet ? `: ${s.snippet.slice(0, 160)}` : ""}`;
  if (s.kind === "video") {
    const about = [s.publisher, s.length, s.views ? `${s.views} views` : ""].filter(Boolean).join(", ");
    return `[video] ${s.title}${about ? ` (${about})` : ""}\n${s.url}`;
  }
  const head = `[${s.kind}] ${s.title}${s.date ? ` (${s.date.slice(0, 10)})` : ""}\n${s.url}`;
  return `${head}\n${s.snippet}`;
}
