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

// Health check
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "golpro-clipserver" });
});

// Status de um clipe
app.get("/status/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("clipes")
    .select("id, status, url_clipe, titulo")
    .eq("id", req.params.id)
    .single();

  if (error) return res.status(404).json({ error: "Clipe não encontrado" });
  res.json(data);
});

// Gerar clipe
app.post("/gerar-clipe", async (req, res) => {
  const { clipe_id, youtube_url, inicio_segundos, fim_segundos, titulo } = req.body;

  if (!clipe_id || !youtube_url || inicio_segundos == null || fim_segundos == null) {
    return res.status(400).json({ error: "Parâmetros obrigatórios: clipe_id, youtube_url, inicio_segundos, fim_segundos" });
  }

  const duracao = fim_segundos - inicio_segundos;
  if (duracao <= 0 || duracao > 300) {
    return res.status(400).json({ error: "Duração inválida. Máximo 5 minutos." });
  }

  // Responde imediatamente e processa em background
  res.json({ ok: true, clipe_id, status: "processando" });

  // Atualiza status para processando
  await supabase.from("clipes").update({ status: "processando" }).eq("id", clipe_id);

  // Processa em background
  processarClipe({ clipe_id, youtube_url, inicio_segundos, duracao, titulo }).catch(console.error);
});

async function processarClipe({ clipe_id, youtube_url, inicio_segundos, duracao, titulo }) {
  const tmpDir = await mkdtemp(join(tmpdir(), "golpro-"));
  const outFile = join(tmpDir, `${randomUUID()}.mp4`);

  try {
    console.log(`[${clipe_id}] Obtendo URL do stream...`);

    // Pega a URL direta do stream via yt-dlp
    const streamUrl = await new Promise((resolve, reject) => {
      const ytdlp = spawn("yt-dlp", ["-g", "-f", "best[ext=mp4]/best", youtube_url]);
      let out = "";
      ytdlp.stdout.on("data", (d) => (out += d));
      ytdlp.on("close", (code) => {
        if (code === 0) resolve(out.trim().split("\n")[0]);
        else reject(new Error(`yt-dlp saiu com código ${code}`));
      });
    });

    console.log(`[${clipe_id}] Cortando clipe ${inicio_segundos}s → ${inicio_segundos + duracao}s`);

    // Corta com ffmpeg
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

    // Upload para Supabase Storage
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

    console.log(`[${clipe_id}] Clipe pronto: ${urlData.publicUrl}`);

  } catch (err) {
    console.error(`[${clipe_id}] Erro:`, err.message);
    await supabase.from("clipes").update({ status: "erro" }).eq("id", clipe_id);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

app.listen(PORT, () => console.log(`GolPro ClipServer rodando na porta ${PORT}`));
