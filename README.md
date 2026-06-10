# golpro-clipserver

Servidor Node.js que baixa vídeos do YouTube via `yt-dlp`, corta o trecho com `ffmpeg`, faz upload para o Supabase Storage e atualiza a tabela `clipes`.

## Arquivos
- `server.js` — API Express (`GET /`, `POST /gerar-clipe`, `GET /status/:id`)
- `package.json` — dependências (`express`, `@supabase/supabase-js`)
- `Dockerfile` — imagem com `ffmpeg` + `yt-dlp` + Node 20

## Variáveis de ambiente
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BUCKET` (opcional, padrão `golpro-clipes`)
- `PORT` (Render injeta automaticamente)

## Deploy no Render
1. Suba esta pasta como repositório no GitHub.
2. Render → New → Web Service → Docker.
3. Configure as envs acima.
4. Crie o bucket público `golpro-clipes` no Supabase.
5. Salve a URL gerada (`https://....onrender.com`) como secret `CLIP_SERVER_URL` no Lovable.

## Payload
```json
POST /gerar-clipe
{
  "clipe_id": "uuid",
  "youtube_url": "https://youtube.com/watch?v=...",
  "inicio_segundos": 1384,
  "fim_segundos": 1414,
  "titulo": "Gol do Areão A - 23min"
}
```

A resposta é imediata (`{ ok: true, status: "processando" }`); o processamento ocorre em background e atualiza `clipes.status` para `pronto` com `url_clipe` ao terminar (ou `erro` em caso de falha).