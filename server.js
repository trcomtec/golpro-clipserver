import express from "express";
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
  auth: { persistSession: false },
});

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "golpro-clipserver" });
});

app.get("/status/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("clipes")
    .select("id, status, url_clipe")
    .eq("id", req.params.id)
    .single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

app.post("/gerar-clipe", async (req, res) => {
  const { clipe_id, youtube_url, inicio_segundos, fim_segundos, titulo } = req.body ?? {};
  if (!clipe_id || !youtube_url || inicio_segundos == null || fim_segundos == null) {
    return res.status(400).json({ error: "Payload invalido" });
  }
  if (fim_segundos <= inicio_segundos) {
    return res.status(400).json({ error: "fim_segundos deve ser maior que inicio_segundos" });
  }

  // Responde rapido — processamento roda em background
  res.json({ ok: true, clipe_id, status: "processando" });

  processarClipe({ clipe_id, youtube_url, inicio_segundos, fim_segundos, titulo }).catch(
    async (err) => {
      console.error("[clipe]", clipe_id, err);
      await supabase.from("clipes").update({ status: "erro" }).eq("id", clipe_id);
    },
  );
});

async function processarClipe({ clipe_id, youtube_url, inicio_segundos, fim_segundos }) {
  await supabase.from("clipes").update({ status: "processando" }).eq("id", clipe_id);

  const workdir = await mkdtemp(join(tmpdir(), `clipe-${clipe_id}-`));
  const outFile = join(workdir, `${randomUUID()}.mp4`);

  try {
    const duracao = fim_segundos - inicio_segundos;
    // Pega a URL direta do stream de video+audio combinado e corta com ffmpeg
    const directUrl = await run("yt-dlp", [
      "-f", "best[ext=mp4]/best",
      "-g",
      youtube_url,
    ]);
    const videoUrl = directUrl.trim().split("\n")[0];

    await runStream("ffmpeg", [
      "-y",
      "-ss", String(inicio_segundos),
      "-i", videoUrl,
      "-t", String(duracao),
      "-c:v", "libx264",
      "-c:a", "aac",
      "-preset", "veryfast",
      "-movflags", "+faststart",
      outFile,
    ]);

    const buffer = await readFile(outFile);
    const path = `${clipe_id}.mp4`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: "video/mp4", upsert: true });
    if (upErr) throw upErr;

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);

    await supabase
      .from("clipes")
      .update({ status: "pronto", url_clipe: pub.publicUrl })
      .eq("id", clipe_id);

    console.log("[clipe] pronto", clipe_id, pub.publicUrl);
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exit ${code}: ${stderr}`));
    });
  });
}

function runStream(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exit ${code}`));
    });
  });
}

app.listen(PORT, () => {
  console.log(`golpro-clipserver ouvindo em :${PORT}`);
});
