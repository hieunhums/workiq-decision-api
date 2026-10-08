"use client";

import { useCallback, useRef, useState } from "react";
import type { Certainty, Odds } from "./jev";
import type { Field } from "./workiq/records";
import type { WebSource } from "./webiq";

export type Turn = {
  id: string;
  who: "you" | "assistant";
  text: string;
  done: boolean;
  /**
   * The question this belongs to: the id of the person's turn it answers, or
   * its own id for a person's turn. Lets the page show one card per question
   * rather than two unrelated lists.
   */
  exchange: string;
  at: number;
  /** Typed to the text model rather than said in a call. Written replies keep their line breaks. */
  written?: boolean;
};

/** One message in the text model's conversation, in chat completions form. */
type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type Chunk =
  | { type: "delta"; text: string }
  | { type: "tools"; calls: { id: string; name: string; arguments: string }[] }
  | { type: "done" }
  | { type: "error"; error: string };

export type Lookup = {
  id: string;
  /** Which tool the model called. Web lookups have sources and no trace. */
  kind: "workplace" | "web";
  question: string;
  /** The person's turn this lookup was made for. */
  exchange: string;
  /** When it started. What was said before it is preamble, after it answer. */
  at: number;
  /** Fetched records as fields, for laying out as rows. Display only. */
  records?: Field[][] | null;
  status: "running" | "done" | "failed";
  seconds?: number;
  error?: string;
  found?: boolean;
  /** What came back. Kept so the card can show what the routing actually bought. */
  text?: string;
  trace?: Trace;
  /**
   * Jev's choice, streamed ahead of the answer so the card can show it while
   * Work IQ is still reaching. `routedAt` is when it landed on this page.
   */
  routing?: Trace["routing"];
  routedAt?: number;
  /** Only for web lookups: the pages, news, quote or forecast it read. */
  sources?: WebSource[];
  /** Asked by the text model for a typed question, not by the voice model. */
  written?: boolean;
  /** Which way it was answered. Missing means Jev, for lookups made before the choice existed. */
  engine?: Engine;
  /** Only for `picks`: the calls the model chose, and its own thinking time. */
  steps?: Rival["steps"];
  modelSeconds?: number;
  /**
   * The same question answered the two other ways, filled in only when someone
   * asks to compare. `picks` is a model holding Work IQ's tools and choosing
   * its own calls; `direct` is the question sent straight to Work IQ's `ask`.
   */
  rivals?: Partial<Record<RivalKind, Rival>>;
};

type RivalKind = "picks" | "direct";

/**
 * How a workplace question is answered. `jev` routes it; `picks` hands Work
 * IQ's tools to a model that chooses its own calls; `direct` asks Work IQ to
 * compose the answer itself. Chosen by the person, never the model.
 */
export type Engine = "jev" | RivalKind;

export type Rival = {
  status: "running" | "done" | "failed";
  seconds?: number;
  text?: string;
  error?: string;
  /** Only for `picks`: the calls the model chose, placed on the lane's clock. */
  steps?: { tool: string; args: string; at: number; seconds: number; failed: boolean }[];
  /** Only for `picks`: time spent waiting on the model deciding. */
  modelSeconds?: number;
};

/** How far a lookup may reach. `auto` leaves it to Jev. */
export type Lane = "auto" | "record" | "search" | "reasoned";

export type { Certainty, Odds };

type Trace = {
  question: string;
  seconds: number;
  routing: {
    seconds: number;
    depth: "record" | "search" | "reasoned";
    record: string | null;
    meaning: string | null;
    scope: string | null;
    reach: Certainty | null;
    /** The probability that the question names each source, asked one by one. */
    sources: Odds[];
    /** The probability that it singles out one particular named thing. */
    particular: number | null;
    /** A record that was searched instead, because one thing in it was named. */
    narrowedFrom: string | null;
    /** The separate requests the question was cut into. Empty when it is one. */
    parts: {
      question: string;
      depth: "record" | "search" | "reasoned";
      record: string | null;
      scope: string | null;
    }[];
    forced: "record" | "search" | "reasoned" | null;
    overruled: string | null;
  };
  steps: {
    what: string;
    tool: string;
    seconds: number;
    found: number | null;
    bytes: number;
  }[];
};

type Phase = "idle" | "connecting" | "live" | "failed";

/**
 * One realtime call.
 *
 * Audio goes straight from the browser to Foundry over WebRTC, which is why
 * this is not proxied: a relay would add a hop to every packet of a live
 * conversation. Only two things touch our server, and both are cheap: minting
 * the session key, and running a workplace lookup when the model asks for one.
 *
 * The data channel is opened without `webrtcfilter=on`. The filter keeps
 * session instructions out of the browser, but it also drops every function
 * call event, which is how the model asks for a lookup. Tool calling and the
 * filter cannot both be had.
 */
export function useRealtime() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [lookups, setLookups] = useState<Lookup[]>([]);
  const [speaking, setSpeaking] = useState(false);
  /** The service's voice detector hears the person talking. */
  const [hearing, setHearing] = useState(false);
  /** The person's latest turn, which everything that follows belongs to. */
  const lastYou = useRef("");
  const levels = useRef<{ input: AnalyserNode | null; output: AnalyserNode | null; context: AudioContext | null }>({
    input: null,
    output: null,
    context: null,
  });
  /**
   * Where the service is in a turn, from this side of the wire.
   *
   * "asked" is the gap between sending response.create and the service
   * confirming it. That gap is a few hundred milliseconds, and both a returning
   * Work IQ lookup and an impatient user land in it often enough to matter.
   * Treating it as free produces "already has an active response"; treating it
   * as running produces "cancellation failed: no active response". So it is
   * neither, and requests made during it are held.
   */
  const stage = useRef<"free" | "asked" | "running">("free");
  /** A turn is owed once the current one ends. */
  const queued = useRef(false);
  /** An interruption arrived before the service confirmed the turn. */
  const cutWhenCreated = useRef(false);
  /**
   * Which question each response answers. A lookup can finish after the
   * person has already asked something else, and the reply to it still
   * belongs under the first question, not the latest one.
   */
  const askedFor = useRef("");
  const queuedFor = useRef("");
  const owners = useRef(new Map<string, string>());

  /**
   * Kept in refs as well as state because the lookup runs from inside a data
   * channel handler, which would otherwise see the value from when the call
   * started rather than the one on screen now.
   */
  const lane = useRef<Lane>("auto");
  const [laneShown, setLaneShown] = useState<Lane>("auto");
  const chooseLane = useCallback((next: Lane) => {
    lane.current = next;
    setLaneShown(next);
  }, []);
  const engine = useRef<Engine>("jev");
  const [engineShown, setEngineShown] = useState<Engine>("jev");
  const chooseEngine = useCallback((next: Engine) => {
    engine.current = next;
    setEngineShown(next);
  }, []);
  const alwaysRef = useRef(false);
  const [always, setAlwaysShown] = useState(false);
  const chooseAlways = useCallback((next: boolean) => {
    alwaysRef.current = next;
    setAlwaysShown(next);
  }, []);

  const connection = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const microphone = useRef<MediaStream | null>(null);

  const send = useCallback((event: unknown) => {
    const open = channel.current;
    if (open?.readyState === "open") open.send(JSON.stringify(event));
  }, []);

  /** Asks for a turn, or holds the request until the current one ends. */
  const turn = useCallback(
    (owner: string) => {
      if (stage.current !== "free") {
        queued.current = true;
        queuedFor.current = owner;
        return;
      }
      stage.current = "asked";
      askedFor.current = owner;
      send({ type: "response.create" });
    },
    [send],
  );

  /** Cuts the current turn short, whether or not it has been confirmed yet. */
  const cut = useCallback(() => {
    if (stage.current === "running") send({ type: "response.cancel" });
    if (stage.current === "asked") cutWhenCreated.current = true;
    send({ type: "output_audio_buffer.clear" });
    setSpeaking(false);
  }, [send]);

  /**
   * Answers the same question the two other ways, side by side.
   *
   * Deliberately after the fact. Running these alongside the routed lookup
   * would make every spoken answer wait on the thing it is being compared
   * against. Both rivals run at once, because they are independent and the
   * point is to see all three finish on one clock.
   */
  const compare = useCallback(async (id: string, question: string) => {
    const set = (kind: RivalKind, rival: Rival) =>
      setLookups((all) =>
        all.map((l) => (l.id === id ? { ...l, rivals: { ...l.rivals, [kind]: rival } } : l)),
      );
    const one = async (kind: RivalKind) => {
      set(kind, { status: "running" });
      try {
        const response = await fetch("/api/workplace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, mode: kind }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        set(kind, {
          status: "done",
          seconds: payload.seconds,
          text: payload.text,
          steps: payload.steps,
          modelSeconds: payload.modelSeconds,
        });
      } catch (error) {
        set(kind, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    await Promise.all([one("picks"), one("direct")]);
  }, []);

  /** Hands a tool result to the model and asks for the turn that speaks it. */
  const reply = useCallback(
    (callId: string, output: string, exchange: string) => {
      send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      });
      // A Work IQ read takes seconds, and in that gap the user may well have
      // asked something else. Asking for a response while one is running is
      // rejected outright, so the result waits for the running turn to end.
      turn(exchange);
    },
    [send, turn],
  );

  const settle = useCallback((callId: string, started: number, patch: Partial<Lookup>) => {
    setLookups((all) =>
      all.map((l) =>
        l.id === callId ? { ...l, seconds: (Date.now() - started) / 1000, ...patch } : l,
      ),
    );
  }, []);

  /**
   * Places a lookup, or fills in one already placed. The card appears the
   * moment the model starts a tool call, before its arguments have streamed,
   * so the choice between tools is seen as it is made.
   */
  const typed = useRef(new Set<string>());
  const open = useCallback(
    (callId: string, kind: Lookup["kind"], question: string, exchange: string) => {
      const written = typed.current.has(exchange);
      const by = kind === "workplace" ? engine.current : undefined;
      setLookups((all) =>
        all.some((l) => l.id === callId)
          ? all.map((l) => (l.id === callId ? { ...l, kind, question, exchange } : l))
          : [
              ...all,
              {
                id: callId,
                kind,
                question,
                exchange,
                at: Date.now(),
                status: "running",
                written,
                engine: by,
              },
            ],
      );
    },
    [],
  );

  /**
   * Runs one workplace lookup and returns what the model should read. The
   * caller hands it back: over the data channel in a call, or to the chat
   * model in text.
   */
  const lookup = useCallback(
    async (callId: string, question: string, exchange: string): Promise<string> => {
      open(callId, "workplace", question, exchange);
      const started = Date.now();
      const by = engine.current;

      let output: string;
      if (by !== "jev") {
        // One of the direct ways, chosen on the page. No plan to stream.
        try {
          const response = await fetch("/api/workplace", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question, mode: by }),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
          const text = String(payload.text ?? "");
          output = payload.now ? `${payload.now}\n\n${text}` : text;
          settle(callId, started, {
            status: "done",
            engine: by,
            found: Boolean(text.trim()),
            text,
            steps: payload.steps,
            modelSeconds: payload.modelSeconds,
          });
        } catch (failure) {
          const detail = failure instanceof Error ? failure.message : String(failure);
          output = unreachable(detail);
          settle(callId, started, { status: "failed", engine: by, error: detail });
        }
        return output;
      }

      try {
        const response = await fetch("/api/workplace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question,
            lane: lane.current === "auto" ? null : lane.current,
            stream: true,
          }),
        });
        if (!response.ok || !response.body) {
          const failed = await response.json().catch(() => ({}));
          throw new Error(failed.error ?? `HTTP ${response.status}`);
        }
        const payload = await lines(response.body, (plan) =>
          setLookups((all) =>
            all.map((l) =>
              l.id === callId ? { ...l, routing: plan.routing, routedAt: Date.now() } : l,
            ),
          ),
        );
        output = payload.now ? `${payload.now}\n\n${payload.text}` : payload.text;
        settle(callId, started, {
          status: "done",
          found: !payload.foundNothing,
          text: payload.text,
          records: payload.records ?? null,
          trace: payload.trace,
        });
      } catch (failure) {
        const detail = failure instanceof Error ? failure.message : String(failure);
        output = unreachable(detail);
        settle(callId, started, { status: "failed", error: detail });
      }

      // Started, not awaited, so comparing never delays the answer.
      if (alwaysRef.current && question) void compare(callId, question);
      return output;
    },
    [compare, open, settle],
  );

  /** Runs one web search. No routing and no comparison: it has one reach. */
  const browse = useCallback(
    async (callId: string, query: string, show: string | null, exchange: string): Promise<string> => {
      open(callId, "web", query, exchange);
      const started = Date.now();

      let output: string;
      try {
        const response = await fetch("/api/web", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, show }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        output = `${payload.now}\n\n${payload.text}`;
        settle(callId, started, {
          status: "done",
          found: !payload.foundNothing,
          text: payload.text,
          sources: payload.sources ?? [],
        });
      } catch (failure) {
        const detail = failure instanceof Error ? failure.message : String(failure);
        output = `The web search failed: ${detail}. Tell the user you could not search the web just now.`;
        settle(callId, started, { status: "failed", error: detail });
      }
      return output;
    },
    [open, settle],
  );

  /** Runs one tool call the model made, with its arguments as the model sent them. */
  const run = useCallback(
    (callId: string, name: string, raw: string, owner: string): Promise<string> => {
      let args: { question?: unknown; query?: unknown; show?: unknown } = {};
      try {
        args = JSON.parse(raw || "{}");
      } catch {
        args = {};
      }
      if (name === "search_web" || (!name && args.query !== undefined)) {
        const show = typeof args.show === "string" ? args.show : null;
        return browse(callId, String(args.query ?? ""), show, owner);
      }
      return lookup(callId, String(args.question ?? ""), owner);
    },
    [browse, lookup],
  );

  const handle = useCallback(
    (event: Record<string, unknown>) => {
      const type = String(event.type ?? "");

      if (type === "error") {
        const detail = (event.error as { message?: string } | undefined)?.message;
        setError(detail ?? "The session reported an error.");
        return;
      }

      // What the model is saying, as it says it.
      if (type === "response.output_audio_transcript.delta") {
        const id = String(event.response_id ?? "live");
        const delta = String(event.delta ?? "");
        const exchange = owners.current.get(id) ?? lastYou.current;
        setTurns((all) => {
          const index = all.findIndex((t) => t.id === id && t.who === "assistant");
          if (index !== -1) {
            const next = [...all];
            next[index] = { ...all[index], text: all[index].text + delta };
            return next;
          }
          return [
            ...all,
            { id, who: "assistant", text: delta, done: false, exchange, at: Date.now() },
          ];
        });
        return;
      }
      if (type === "response.output_audio_transcript.done") {
        const id = String(event.response_id ?? "live");
        setTurns((all) => all.map((t) => (t.id === id ? { ...t, done: true } : t)));
        return;
      }

      if (type === "input_audio_buffer.speech_started") setHearing(true);
      if (type === "input_audio_buffer.speech_stopped") setHearing(false);

      // The person's turn is placed when their speech is committed, not when
      // its transcript lands. Transcription finishes after the model has often
      // started replying, and placing the turn then put the answer above the
      // question it answered.
      if (type === "input_audio_buffer.committed") {
        const id = String(event.item_id ?? crypto.randomUUID());
        lastYou.current = id;
        setHearing(false);
        setTurns((all) =>
          all.some((t) => t.id === id)
            ? all
            : [...all, { id, who: "you", text: "", done: false, exchange: id, at: Date.now() }],
        );
        return;
      }

      // What the person said, once the service has transcribed it.
      if (
        type === "conversation.item.input_audio_transcription.completed" ||
        type === "conversation.item.input_audio_transcription.failed"
      ) {
        const id = String(event.item_id ?? crypto.randomUUID());
        const text = String(event.transcript ?? "").trim();
        setTurns((all) => {
          if (all.some((t) => t.id === id)) {
            return all.map((t) => (t.id === id ? { ...t, text, done: true } : t));
          }
          return [...all, { id, who: "you", text, done: true, exchange: id, at: Date.now() }];
        });
        return;
      }

      if (type === "output_audio_buffer.started") setSpeaking(true);
      if (type === "output_audio_buffer.stopped") setSpeaking(false);

      // Tracked separately from speaking. A response can be running with no
      // audio yet, or be waiting on a tool, and asking during either window is
      // what produces "conversation already has an active response".
      if (type === "response.created") {
        const id = String((event.response as { id?: string } | undefined)?.id ?? "");
        // One this page asked for belongs to whoever asked. One the service
        // started itself follows the person's speech, so it is theirs.
        if (id) owners.current.set(id, stage.current === "asked" ? askedFor.current : lastYou.current);
        stage.current = "running";
        if (cutWhenCreated.current) {
          cutWhenCreated.current = false;
          send({ type: "response.cancel" });
        }
      }
      if (type === "response.done" || type === "response.cancelled") {
        stage.current = "free";
        if (queued.current) {
          queued.current = false;
          turn(queuedFor.current);
        }
      }

      // The model has picked a tool. Its arguments follow over the next few
      // hundred milliseconds; the card goes up now so the pick is seen.
      if (type === "response.output_item.added") {
        const item = event.item as { type?: string; name?: string; call_id?: string } | undefined;
        if (item?.type === "function_call" && item.call_id) {
          const owner = owners.current.get(String(event.response_id ?? "")) ?? lastYou.current;
          open(item.call_id, item.name === "search_web" ? "web" : "workplace", "", owner);
        }
        return;
      }

      if (type === "response.function_call_arguments.done") {
        // Filed under the question whose response asked for it. Noise the
        // voice detector picked up meanwhile is a newer turn, not the asker.
        const owner = owners.current.get(String(event.response_id ?? "")) ?? lastYou.current;
        const callId = String(event.call_id ?? "");
        void run(callId, String(event.name ?? ""), String(event.arguments ?? ""), owner).then(
          (output) => reply(callId, output, owner),
        );
      }
    },
    [open, reply, run, send, turn],
  );

  const start = useCallback(
    async (voice = "marin") => {
      setError(null);
      setPhase("connecting");
      // Fire and forget. The Work IQ client starts while the call connects,
      // rather than during the first answer. A failure here is harmless: the
      // first lookup starts it anyway, just slower.
      void fetch("/api/workplace", { method: "PUT" }).catch(() => undefined);
      // Made before the first await, while the click still counts as a user
      // gesture, or the browser starts it suspended and the meters read zero.
      const context = new AudioContext();
      levels.current.context = context;
      try {
        const minted = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voice }),
        });
        const session = await minted.json();
        if (!minted.ok) throw new Error(session.detail ?? session.error ?? "Could not start a session.");

        const peer = new RTCPeerConnection();
        connection.current = peer;

        const element = new Audio();
        element.autoplay = true;
        audio.current = element;
        peer.ontrack = (event) => {
          if (!event.streams[0]) return;
          element.srcObject = event.streams[0];
          // Metered, not played, through Web Audio. The element still plays it;
          // Chrome delivers silence to Web Audio from a remote stream that is
          // not also attached to a media element.
          const output = context.createAnalyser();
          output.fftSize = 512;
          context.createMediaStreamSource(event.streams[0]).connect(output);
          levels.current.output = output;
        };

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        microphone.current = stream;
        const input = context.createAnalyser();
        input.fftSize = 512;
        context.createMediaStreamSource(stream).connect(input);
        levels.current.input = input;
        peer.addTrack(stream.getAudioTracks()[0], stream);

        const data = peer.createDataChannel("realtime-channel");
        channel.current = data;
        data.addEventListener("open", () => setPhase("live"));
        data.addEventListener("message", (message) => {
          try {
            handle(JSON.parse(message.data));
          } catch {
            // A message that is not JSON is not ours to read.
          }
        });

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);

        // No webrtcfilter here: it would drop the function call events.
        const answered = await fetch(
          `https://${session.host}/openai/v1/realtime/calls`,
          {
            method: "POST",
            body: offer.sdp,
            headers: {
              Authorization: `Bearer ${session.key}`,
              "Content-Type": "application/sdp",
            },
          },
        );
        if (!answered.ok) {
          throw new Error(`The call was refused: ${answered.status} ${await answered.text()}`);
        }
        await peer.setRemoteDescription({ type: "answer", sdp: await answered.text() });

        peer.onconnectionstatechange = () => {
          if (["failed", "closed", "disconnected"].includes(peer.connectionState)) {
            setPhase("idle");
          }
        };
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setPhase("failed");
      }
    },
    [handle],
  );

  const stop = useCallback(() => {
    channel.current?.close();
    connection.current?.close();
    microphone.current?.getTracks().forEach((track) => track.stop());
    if (audio.current) audio.current.srcObject = null;
    channel.current = null;
    connection.current = null;
    microphone.current = null;
    setPhase("idle");
    setSpeaking(false);
    setHearing(false);
    void levels.current.context?.close();
    levels.current = { input: null, output: null, context: null };
    stage.current = "free";
    queued.current = false;
    cutWhenCreated.current = false;
  }, []);

  /** Cuts the model off mid sentence, the way interrupting a person works. */
  const hush = useCallback(() => {
    queued.current = false;
    cut();
  }, [cut]);

  /** Types a question instead of speaking it. Useful when a room is loud. */
  const ask = useCallback(
    (text: string) => {
      // Asking while it is still answering is an interruption, not an error.
      // It is what a person does to someone who is going on too long, so the
      // running response is cut rather than the new question refused.
      cut();
      queued.current = false;
      send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      });
      const id = crypto.randomUUID();
      lastYou.current = id;
      turn(id);
      setTurns((all) => [
        ...all,
        { id, who: "you", text, done: true, exchange: id, at: Date.now() },
      ]);
    },
    [cut, send, turn],
  );

  /**
   * Answers a typed question with the text model, no call needed. The tools
   * run through the same lookup and browse as in a call, so the cards, the
   * choosing animation and the replay are identical; only the voice is gone.
   * The conversation is kept, so a follow-up can say "and tomorrow?".
   */
  const history = useRef<ChatMessage[]>([]);
  /**
   * Typed questions are answered one after another. A question slipped in
   * while the last one's lookup is still out would land between the model's
   * tool call and its result, and the model rejects that conversation.
   */
  const line = useRef<Promise<void>>(Promise.resolve());
  const waiting = useRef(0);
  const [writing, setWriting] = useState(false);
  const answerText = useCallback(
    async (text: string, you: string) => {
      const before = history.current;
      history.current = [...history.current, { role: "user", content: text }];
      try {
        // A few rounds at most: a lookup, perhaps a second one, then the answer.
        for (let round = 0; round < 4; round++) {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: history.current }),
          });
          if (!response.ok || !response.body) {
            const failed = await response.json().catch(() => ({}));
            throw new Error(failed.error ?? `HTTP ${response.status}`);
          }
          const id = crypto.randomUUID();
          let said = "";
          let last: Chunk | null = null;
          await chunks(response.body, (chunk) => {
            last = chunk;
            if (chunk.type !== "delta") return;
            said += chunk.text;
            const current = said;
            setTurns((all) =>
              all.some((t) => t.id === id)
                ? all.map((t) => (t.id === id ? { ...t, text: current } : t))
                : [
                    ...all,
                    {
                      id,
                      who: "assistant",
                      text: current,
                      done: false,
                      exchange: you,
                      at: Date.now(),
                      written: true,
                    },
                  ],
            );
          });
          setTurns((all) => all.map((t) => (t.id === id ? { ...t, done: true } : t)));
          const end = last as Chunk | null;
          if (end?.type === "error") throw new Error(end.error);
          if (end?.type !== "tools") {
            history.current = [...history.current, { role: "assistant", content: said }];
            return;
          }

          history.current = [
            ...history.current,
            {
              role: "assistant",
              content: said || null,
              tool_calls: end.calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            },
          ];
          const outputs = await Promise.all(
            end.calls.map(async (call) => ({
              role: "tool" as const,
              tool_call_id: call.id,
              content: await run(call.id, call.name, call.arguments, you),
            })),
          );
          history.current = [...history.current, ...outputs];
        }
      } catch (failure) {
        // Forgotten rather than left half-finished, so the next one still works.
        history.current = before;
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [run],
  );

  const askText = useCallback(
    (text: string) => {
      const you = crypto.randomUUID();
      typed.current.add(you);
      lastYou.current = you;
      setError(null);
      setTurns((all) => [
        ...all,
        { id: you, who: "you", text, done: true, exchange: you, at: Date.now(), written: true },
      ]);
      waiting.current += 1;
      setWriting(true);
      line.current = line.current.then(async () => {
        await answerText(text, you);
        waiting.current -= 1;
        if (!waiting.current) setWriting(false);
      });
      return line.current;
    },
    [answerText],
  );

  /** Loudness of each side, 0 to 1, read on demand so it costs no renders. */
  const meter = useCallback(() => {
    const read = (node: AnalyserNode | null) => {
      if (!node) return 0;
      const samples = new Uint8Array(node.fftSize);
      node.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / samples.length) * 4);
    };
    return { input: read(levels.current.input), output: read(levels.current.output) };
  }, []);

  return {
    meter,
    hearing,
    phase,
    error,
    turns,
    lookups,
    speaking,
    start,
    stop,
    hush,
    ask,
    askText,
    writing,
    compare,
    lane: laneShown,
    setLane: chooseLane,
    engine: engineShown,
    setEngine: chooseEngine,
    always,
    setAlways: chooseAlways,
  };
}

/**
 * What the model reads when a lookup fails. It is told plainly: saying nothing
 * would let it fill the silence with something invented.
 */
function unreachable(detail: string): string {
  return `The lookup failed: ${detail}. Tell the user you could not reach their workplace data.`;
}

type Streamed =
  | { type: "plan"; routing: Trace["routing"] }
  | {
      type: "done";
      text: string;
      now: string;
      records: Field[][] | null;
      foundNothing: boolean;
      trace: Trace;
    }
  | { type: "error"; error: string };

/**
 * Reads the workplace answer as lines of JSON. Jev's plan arrives first and is
 * handed to `onPlan`; the answer ends the stream and is returned.
 */
async function lines(
  body: ReadableStream<Uint8Array>,
  onPlan: (plan: Extract<Streamed, { type: "plan" }>) => void,
): Promise<Extract<Streamed, { type: "done" }>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffered += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Streamed;
      if (message.type === "plan") onPlan(message);
      else if (message.type === "error") throw new Error(message.error);
      else return message;
    }
    if (done) throw new Error("The answer stream ended early.");
  }
}

/** Reads the text model's NDJSON stream, one chunk per line. */
async function chunks(body: ReadableStream<Uint8Array>, each: (chunk: Chunk) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const rows = buffer.split("\n");
    buffer = rows.pop() ?? "";
    for (const row of rows) if (row.trim()) each(JSON.parse(row) as Chunk);
  }
  if (buffer.trim()) each(JSON.parse(buffer) as Chunk);
}
