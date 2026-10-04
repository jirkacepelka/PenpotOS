# PenpotOS

Self-hostovaný [Penpot](https://penpot.app) pro organizace – postavený pro **Libertariánskou stranu Voluntia**, ale použitelný kdekoli.

PenpotOS bere oficiální Penpot (2.18) a přidává k němu tři věci, které mu pro uzavřený tým chybí:

| | Co to dělá |
|---|---|
| 🔒 **Uzavřený server + admin dashboard** | Registrace je vypnutá, účty zakládá jen administrátor. Každý člen se automaticky dostane do všech týmů a dostane sdílenou brand knihovnu (paleta barev, typografie) a výchozí projekty. Blokování, reset hesel, role, audit log. |
| 🤖 **Online MCP server pro AI** | Stejné nástroje jako [oficiální Penpot MCP](https://github.com/penpot/penpot/tree/develop/mcp) (`execute_code`, `export_shape`, `import_image`, dokumentace Plugin API…), ale **nepotřebuje otevřený Penpot v prohlížeči** – soubory otevírá headless Penpot přímo na serveru. Funguje odkudkoliv jako *custom connector* v Claude chatu (web, desktop, mobil), každý člen se přihlásí svým účtem (OAuth). AI má přístup ke **všem** týmům a souborům, ne jen k jednomu otevřenému. |
| 💬 **Discord bot** | Přijímá úkoly v nastavených kanálech, pracuje přes stejné MCP a do vlákna posílá výsledek s náhledy (PNG exporty) a odkazy na soubory. AI: Anthropic API, Claude předplatné (Agent SDK) nebo OpenAI-kompatibilní API. |

Všechno (včetně oprávnění AI) se nastavuje **jen v admin dashboardu**.

## Architektura

```
                         internet (Cloudflare Tunnel, HTTPS)
                                       │
                         ┌─────────────▼──────────────┐
  členové / Claude ─────►│ penpotos-core  :9001        │  gateway: blokuje registraci,
                         │  ├─ gateway  ──────────────►│──► penpot-frontend ─► penpot-backend ─► postgres
                         │  └─ admin dashboard :9002   │      (nginx)            │  ▲ PREPL (správa účtů)
                         └──────┬──────────────────────┘                         │  │
                     /mcp, OAuth│                                                │  │
                         ┌──────▼──────────────────────┐   Plugin API v headless │  │
                         │ penpotos-mcp                │──── Chromiu (Penpot ────┘  │
                         │  MCP server + OAuth 2.1     │      workspace)            │
                         └──────▲──────────────────────┘                            │
                                │ interní token                                     │
                         ┌──────┴──────────────────────┐                            │
   Discord ◄────────────►│ penpotos-discord            │        nastavení, audit ───┘
                         │  bot + AI agent (Claude…)   │        (schéma penpotos v DB)
                         └─────────────────────────────┘
```

* **`services/core`** – veřejný vstup (reverse proxy před Penpotem, blokace `register-profile`, směrování MCP/OAuth), admin dashboard, synchronizace členství a brand knihoven.
* **`services/mcp`** – MCP server (Streamable HTTP) s OAuth 2.1 (dynamická registrace klientů, PKCE), pool headless Chromia s otevřenými soubory. Kód od AI běží proti stejnému Plugin API, jaké používá oficiální MCP plugin (`penpot`, `penpotUtils`, `storage`), takže kvalita i dokumentace jsou stejné. Režim „jen čtení“ blokuje ukládání na úrovni sítě.
* **`services/discord`** – Discord bot, konverzace ve vláknech, průběh úkolu, přílohy.
* **`packages/shared`** – DB schéma `penpotos` (nastavení, tokeny, audit), klienti pro Penpot RPC a PREPL.
* **`vendor/penpot-mcp`** – převzaté části oficiálního Penpot MCP (MPL-2.0): `PenpotUtils`, instrukce pro LLM a dokumentace API. Aktualizace: `scripts/sync-penpot-mcp.sh <verze>`.

## Rychlý start

```bash
git clone https://github.com/jirkacepelka/PenpotOS.git && cd PenpotOS
cp .env.example .env
# vyplň hesla/klíče (openssl rand -hex 32), PENPOTOS_PUBLIC_URL a prvního admina
docker compose up -d                       # jen v lokální síti
docker compose --profile tunnel up -d      # + Cloudflare Tunnel
```

* Penpot: `http://<server>:9001` (nebo tvoje doména přes tunel)
* Admin dashboard: `http://<server>:9002` – přihlášení e-mailem a heslem z `PENPOTOS_ADMIN_*`

Podrobné návody:

* [Instalace na ZimaOS + Cloudflare Tunnel](docs/instalace-zimaos.md) – pro import v rozhraní ZimaOS je připravený [`zimaos/docker-compose.yml`](zimaos/docker-compose.yml)
* [Připojení AI v Claude chatu (MCP connector)](docs/claude-connector.md)
* [Discord bot](docs/discord-bot.md)
* [Architektura, bezpečnost, údržba](docs/architektura.md)

## Vývoj

```bash
npm install
npx tsc -p tsconfig.json   # typecheck
npx vitest run             # testy
```

Služby běží přímo z TypeScriptu (`node --import tsx src/index.ts`). Lokální vývoj proti Penpotu z `docker-compose.yml` je popsaný v [docs/architektura.md](docs/architektura.md#lokální-vývoj).

## Licence

MPL-2.0 (stejně jako Penpot). Složka `vendor/penpot-mcp` obsahuje kód z [penpot/penpot](https://github.com/penpot/penpot) pod MPL-2.0.
