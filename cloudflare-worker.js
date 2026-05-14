// ── YSummarize Transcript Proxy — Cloudflare Worker ──────────────────────────
// Uses YouTube InnerTube API with multiple client fallbacks.
// Deploy at: https://dash.cloudflare.com → Workers & Pages → Create Worker

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const { searchParams } = new URL(request.url);
    const videoUrl = searchParams.get("url");
    if (!videoUrl) return json({ error: "Missing url parameter" }, 400);

    const videoId = extractVideoId(videoUrl);
    if (!videoId) return json({ error: "Invalid YouTube URL" }, 400);

    const errors = [];

    // Try each client in order until one works
    for (const client of CLIENTS) {
      try {
        const tracks = await getCaptionTracks(videoId, client);
        if (!tracks || !tracks.length) continue;

        const track =
          tracks.find((t) => t.languageCode === "en" && !t.kind) ||
          tracks.find((t) => t.languageCode === "en") ||
          tracks[0];

        const transcript = await fetchCaptionText(track.baseUrl);
        if (transcript) return json({ transcript });
      } catch (err) {
        errors.push(`${client.clientName}: ${err.message}`);
      }
    }

    return json({ error: "No captions found. " + errors.join(" | ") }, 500);
  },
};

// ── Client configurations ─────────────────────────────────────────────────────
const CLIENTS = [
  {
    clientName: "TVHTML5",
    clientVersion: "7.20240101.08.00",
    userAgent: "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1",
    clientNameId: "7",
  },
  {
    clientName: "WEB",
    clientVersion: "2.20240101.00.00",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    clientNameId: "1",
  },
  {
    clientName: "ANDROID",
    clientVersion: "19.09.37",
    userAgent: "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
    clientNameId: "3",
    androidSdkVersion: 30,
  },
];

// ── Fetch caption tracks from InnerTube /player ───────────────────────────────
async function getCaptionTracks(videoId, client) {
  const body = {
    videoId,
    context: {
      client: {
        clientName: client.clientName,
        clientVersion: client.clientVersion,
        hl: "en",
        gl: "US",
        ...(client.androidSdkVersion ? { androidSdkVersion: client.androidSdkVersion } : {}),
      },
    },
  };

  const res = await fetch("https://www.youtube.com/youtubei/v1/player", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": client.userAgent,
      "X-YouTube-Client-Name": client.clientNameId,
      "X-YouTube-Client-Version": client.clientVersion,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  return data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
}

// ── Download & parse caption text ────────────────────────────────────────────
async function fetchCaptionText(baseUrl) {
  const res = await fetch(baseUrl + "&fmt=json3");
  if (!res.ok) throw new Error("Caption download failed");
  const data = await res.json();

  const text = (data.events || [])
    .filter((e) => e.segs)
    .flatMap((e) => e.segs)
    .map((s) => (s.utf8 || "").replace(/\n/g, " "))
    .join(" ")
    .replace(/\[.*?\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text.length < 100) throw new Error("Transcript too short");
  return text;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractVideoId(url) {
  const m = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([a-zA-Z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
