# Architektura, bezpečnost, údržba

## Jak funguje headless MCP

Oficiální Penpot MCP funguje tak, že v prohlížeči uživatele běží plugin, který přes WebSocket přijímá od MCP serveru JavaScript a spouští ho proti Plugin API otevřeného souboru. Proto musí být Penpot otevřený.

PenpotOS dělá totéž, jen na serveru:

1. `penpotos-mcp` spustí headless Chromium a přihlásí ho jako servisní účet AI (cookie relace z `login-with-password`).
2. Při prvním nástroji nad souborem otevře `/#/workspace?team-id=…&file-id=…`. Frontend Penpotu při startu vytvoří kontext Plugin API (`globalThis.ɵcontext`, plugin-id `0000…`, který má ve frontendu všechna práva).
3. Do stránky se vloží runtime (`services/mcp/src/runtime/entry.ts` + převzaté `PenpotUtils`), který vystaví `penpot`, `penpotUtils` a `storage` stejně jako oficiální plugin a spouští kód od AI se stejnými flagy (`naturalChildOrdering`, `throwValidationErrors`).
4. Po spuštění se čeká, až Penpot změny uloží (stav persistence `pending → saving → saved`), takže odpověď nástroje znamená „uloženo na serveru“.
5. Otevřené soubory se drží v LRU poolu (max. počet v adminu), nečinné se po 15 min zavřou.

Úpravy headless prohlížeče: `config.js` se přepíše tak, aby frontend volal API přes interní adresu, a požadavky na veřejnou URL (např. výstupy exportéru) se obslouží interně.

**Režim jen pro čtení:** požadavky `update-file` jsou v prohlížeči zablokované; pokud kód něco změnil, nástroj vrátí chybu a záložka se zahodí. Zapisovací nástroje (`create_file`, `import_image`…) se v tomto režimu vůbec nenabízí.

## Správa účtů

* Registrace je vypnutá ve frontendu i backendu (`disable-registration`) a gateway navíc blokuje `prepare-register-profile` / `register-profile`.
* Účty se zakládají přes **PREPL** Penpot backendu (`enable-prepl-server`, port 6063) – stejné API, jaké používá oficiální `manage.py`. Port je dostupný jen ve vnitřní Docker síti, ven se nepublikuje.
* Členství v týmech zapisuje PenpotOS do tabulky `team_profile_rel`; blokace = `profile.is_blocked` + smazání relací.
* Data PenpotOS jsou ve schématu `penpotos` téže databáze (nastavení, tokeny, audit, konverzace Discordu). Migrace Penpotu toto schéma nemění.

## Bezpečnost – doporučení

* Admin dashboard (port 9002) nevystavuj do internetu bez ochrany (Cloudflare Access, VPN, `PENPOTOS_ADMIN_BIND=127.0.0.1`).
* Tajné klíče generuje `penpotos-core` při startu do volume `config` (`/config`, čitelné jen pro kontejnery PenpotOS a Penpotu). Hodnoty v `.env` je volitelně přepíšou. API klíče zadané v adminu jsou v DB šifrované (AES-256-GCM, klíč z `PENPOTOS_SECRET_KEY`).
* OAuth: přístupový token platí 1 h, refresh token 30 dní s rotací; vše lze zrušit v adminu. Odebrání AI přístupu nebo blokace člena zruší jeho tokeny.
* AI pracuje pod servisním účtem, který je editorem ve všech týmech – rozsah omez v *AI & MCP* (týmy, jen čtení).

## Lokální vývoj

```bash
npm install
# Penpot s porty vystavenými na localhost (ukázkový override):
cat > compose.dev.yml <<'EOF'
services:
  penpot-frontend: { ports: ["18080:8080"] }
  penpot-backend: { ports: ["16060:6060", "16063:6063"] }
  penpot-postgres: { ports: ["15432:5432"] }
EOF
docker compose -f docker-compose.yml -f compose.dev.yml up -d penpot-frontend penpot-backend penpot-exporter penpot-postgres penpot-valkey
```

Proměnné pro služby spuštěné mimo Docker:

```bash
export PENPOTOS_DATABASE_URL=postgresql://penpot:<POSTGRES_PASSWORD>@localhost:15432/penpot
export PENPOT_INTERNAL_URL=http://localhost:18080 PENPOT_BACKEND_URL=http://localhost:16060
export PENPOT_PREPL_HOST=localhost PENPOT_PREPL_PORT=16063
export PENPOTOS_MCP_INTERNAL_URL=http://localhost:4400 PENPOTOS_DISCORD_INTERNAL_URL=http://localhost:4500
export PENPOTOS_SECRET_KEY=… PENPOTOS_INTERNAL_TOKEN=… PENPOTOS_PUBLIC_URL=http://localhost:9001
export PENPOTOS_GATEWAY_PORT=9001 PENPOTOS_ADMIN_PORT=9002
npm run dev:core   # / dev:mcp / dev:discord
```

Pro `penpotos-mcp` mimo Docker nastav `CHROMIUM_EXECUTABLE_PATH`, pokud Playwright nenajde prohlížeč.

`scripts/smoke-mcp.ts` projde hlavní MCP nástroje proti běžící instanci (vytvoří soubor, nakreslí board, exportuje ho):

```bash
PENPOTOS_MCP_URL=http://localhost:4400/mcp node --import tsx scripts/smoke-mcp.ts
```

## Proměnné prostředí služeb

| Proměnná | Výchozí | Služba |
|---|---|---|
| `PENPOTOS_CONFIG_DIR` | `/config` | všechny (vygenerované klíče, `public_url`, start skripty Penpotu) |
| `PENPOTOS_PUBLIC_URL` | soubor `public_url` (admin), jinak `http://localhost:9001` | všechny |
| `PENPOTOS_DATABASE_URL` | `postgresql://penpot:<postgres_password>@penpot-postgres:5432/penpot` | všechny |
| `PENPOTOS_SECRET_KEY`, `PENPOTOS_INTERNAL_TOKEN` | soubory z `/config` | všechny |
| `PENPOT_INTERNAL_URL` | `http://penpot-frontend:8080` | core, mcp |
| `PENPOT_BACKEND_URL` | `http://penpot-backend:6060` | všechny |
| `PENPOT_PREPL_HOST` / `PENPOT_PREPL_PORT` | `penpot-backend` / `6063` | core |
| `PENPOTOS_MCP_INTERNAL_URL` | `http://penpotos-mcp:4400` | core, discord |
| `PENPOTOS_BOT_EMAIL`, `PENPOTOS_BOT_NAME` | `ai@penpotos.local`, `Voluntia AI` | core, mcp |
| `PENPOTOS_BOT_RENDERER` | `svg` | core (renderer servisního účtu – headless bez GPU) |
| `PENPOTOS_MCP_IDLE_CLOSE_SECONDS` | `900` | mcp |
| `CHROMIUM_EXECUTABLE_PATH` | (Playwright) | mcp |
| `PENPOTOS_DISCORD_MAX_TASKS` | `3` | discord |
