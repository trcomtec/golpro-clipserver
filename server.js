import express from "express";
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ws from "ws";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  BUCKET = "golpro-clipes",
  PORT = 10000,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltam SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "golpro-clipserver" });
});

app.get("/status/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("clipes")
    .select("id, status, url_clipe, titulo")
    .eq("id", req.params.id)
    .single();
  if (error) return res.status(404).json({ error: "Clipe não encontrado" });
  res.json(data);
});

app.post("/gerar-clipe", async (req, res) => {
  const { clipe_id, youtube_url, inicio_segundos, fim_segundos, titulo } = req.body;

  if (!clipe_id || !youtube_url || inicio_segundos == null || fim_segundos == null) {
    return res.status(400).json({ error: "Parâmetros obrigatórios faltando" });
  }

  const duracao = fim_segundos - inicio_segundos;
  if (duracao <= 0 || duracao > 300) {
    return res.status(400).json({ error: "Duração inválida. Máximo 5 minutos." });
  }

  res.json({ ok: true, clipe_id, status: "processando" });

  await supabase.from("clipes").update({ status: "processando" }).eq("id", clipe_id);

  processarClipe({ clipe_id, youtube_url, inicio_segundos, duracao, titulo }).catch(console.error);
});

async function processarClipe({ clipe_id, youtube_url, inicio_segundos, duracao, titulo }) {
  const tmpDir = await mkdtemp(join(tmpdir(), "golpro-"));
  const outFile = join(tmpDir, `${randomUUID()}.mp4`);

  try {
    console.log(`[${clipe_id}] Obtendo URL do stream...`);

    const streamUrl = await new Promise((resolve, reject) => {
      const ytdlp = spawn("yt-dlp", [
        "-g",
        "--cookies", "/etc/secrets/cookies.txt",
        "-f", "best[ext=mp4]/best",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "--no-check-certificates",
        "--extractor-args", "youtube:player_client=web",
        youtube_url
      ]);
      let out = "";
      let err = "";
      ytdlp.stdout.on("data", (d) => (out += d));
      ytdlp.stderr.on("data", (d) => (err += d));
      ytdlp.on("close", (code) => {
        if (code === 0 && out.trim()) resolve(out.trim().split("\n")[0]);
        else reject(new Error(`yt-dlp erro (${code}): ${err.slice(0, 300)}`));
      });
    });

    console.log(`[${clipe_id}] Cortando ${inicio_segundos}s por ${duracao}s...`);

    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-ss", String(inicio_segundos),
        "-i", streamUrl,
        "-t", String(duracao),
        "-c", "copy",
        "-y",
        outFile,
      ]);
      ff.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg saiu com código ${code}`));
      });
    });

    const fileBuffer = await readFile(outFile);
    const storagePath = `clipes/${clipe_id}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, fileBuffer, { contentType: "video/mp4", upsert: true });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

    await supabase
      .from("clipes")
      .update({ status: "pronto", url_clipe: urlData.publicUrl })
      .eq("id", clipe_id);

    console.log(`[${clipe_id}] Pronto: ${urlData.publicUrl}`);

  } catch (err) {
    console.error(`[${clipe_id}] Erro:`, err.message);
    await supabase.from("clipes").update({ status: "erro" }).eq("id", clipe_id);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

app.listen(PORT, () => console.log(`GolPro ClipServer rodando na porta ${PORT}`));
