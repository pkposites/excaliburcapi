# excalibur-capi

Cloudflare Worker que recebe eventos client-side da LP da Excalibur e
reenvia server-side para a Meta Conversions API, deduplicando via
`event_id` compartilhado com o Pixel do navegador.

📄 Documentação completa: `DOCUMENTATION.md` do projeto (seção 6).

## Deploy
```bash
wrangler deploy
```

## Configurar o secret (obrigatório, sem isso o worker responde 500)
```bash
wrangler secret put META_ACCESS_TOKEN
```
Cole o token de sistema (`ads_management`) gerado em:
Events Manager → Pixel `1916536729320394` → Configurações → Conversions
API → Gerar token de acesso.

**Esse comando NUNCA escreve o token em nenhum arquivo do repositório** —
ele fica só na infraestrutura da Cloudflare. Não existe (e não deve
existir) nenhuma variável `META_ACCESS_TOKEN` dentro de `wrangler.toml`.

## Variáveis (`wrangler.toml`)
| Nome | Tipo | Obrigatória | Observação |
|---|---|---|---|
| `PIXEL_ID` | var | não (tem default) | `1916536729320394` |
| `META_ACCESS_TOKEN` | secret | **sim** | via `wrangler secret put` |
| `TEST_EVENT_CODE` | var | não | só durante testes no Events Manager |
| `ALLOWED_ORIGIN` | var | não | restringe CORS; hoje aceita `*` |

## Endpoints
- `POST /event` — recebe `{event_name, event_id, event_source_url, fbp, fbc}`
- `GET /health` — healthcheck simples (`ok`)

## Testar localmente
```bash
wrangler dev
# em outro terminal:
curl -X POST http://localhost:8787/event \
  -H "Content-Type: application/json" \
  -d '{"event_name":"Lead","event_id":"teste-123","event_source_url":"https://excaliburfestas.netlify.app"}'
```
Pra isso funcionar localmente sem tocar no secret de produção, crie um
`.dev.vars` (já ignorado pelo git) com `META_ACCESS_TOKEN=...` de teste.
