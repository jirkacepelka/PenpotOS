# Instalace na ZimaOS

Návod předpokládá ZimaOS (nebo CasaOS / jakýkoli Linux s Dockerem) a přístup přes SSH nebo webový terminál.
Doporučené minimum: 4 GB RAM (Penpot backend + exportér + headless Chromium pro MCP), 2 CPU.

## 1. Stažení

```bash
cd /DATA/AppData            # na ZimaOS; jinde libovolná složka
git clone https://github.com/jirkacepelka/PenpotOS.git penpotos
cd penpotos
cp .env.example .env
```

> Bez `git`: stáhni ZIP repozitáře z GitHubu a rozbal ho do `/DATA/AppData/penpotos`.

## 2. Konfigurace `.env`

Vygeneruj čtyři tajné hodnoty a vlož je do `.env`:

```bash
for k in POSTGRES_PASSWORD PENPOT_SECRET_KEY PENPOTOS_SECRET_KEY PENPOTOS_INTERNAL_TOKEN; do
  sed -i "s|^$k=.*|$k=$(openssl rand -hex 32)|" .env
done
```

Pak uprav ručně:

| Proměnná | Co nastavit |
|---|---|
| `PENPOTOS_PUBLIC_URL` | Adresa, na které budou členové Penpot otevírat. S Cloudflare Tunnelem např. `https://penpot.voluntia.cz`. **Členové musí vždy používat tuto adresu** (ne IP v lokální síti), jinak prohlížeč zablokuje volání API. |
| `PENPOTOS_ADMIN_EMAIL`, `PENPOTOS_ADMIN_PASSWORD` | První administrátor (vytvoří se při prvním startu). |
| `PENPOTOS_ADMIN_BIND` | `0.0.0.0` = admin dostupný z lokální sítě na portu 9002; `127.0.0.1` = jen ze serveru (SSH tunel). |
| `CLOUDFLARE_TUNNEL_TOKEN` | Viz krok 4. |
| `PENPOT_SMTP_*` | Volitelné – e-maily (obnova hesla, notifikace komentářů). |

`PENPOTOS_SECRET_KEY` šifruje uložené API klíče (Anthropic, Discord). Když ho změníš, je potřeba klíče v adminu zadat znovu.

## 3. Spuštění

```bash
docker compose pull            # stáhne image (Penpot + ghcr.io/jirkacepelka/penpotos-*)
docker compose up -d
docker compose logs -f penpotos-core   # počkej na "PenpotOS core ready"
```

První start trvá 1–3 minuty (Penpot inicializuje databázi). Pak:

* Penpot: `http://<ip-serveru>:9001`
* Admin: `http://<ip-serveru>:9002` → přihlas se adminem z `.env`

> Pokud image `ghcr.io/jirkacepelka/penpotos-*` nejsou veřejné, buď je v GitHubu (Packages → Package settings) přepni na *Public*, nebo je sestav lokálně: `docker compose build`.

### Uživatelské rozhraní ZimaOS

ZimaOS umí importovat compose soubor přes **App Store → ⊕ → Install a customized app → Import**. `docker-compose.yml` obsahuje i metadata `x-casaos`, takže se PenpotOS zobrazí na ploše s ikonou. Proměnné z `.env` ale UI neumí – nejjednodušší je spustit stack přes terminál (krok 3) a ZimaOS ho pak v přehledu aplikací zobrazí.

## 4. Přístup z internetu – Cloudflare Tunnel

MCP connector v Claude vyžaduje veřejnou HTTPS adresu. Cloudflare Tunnel ji dá bez otevírání portů na routeru.

1. V [Cloudflare Zero Trust](https://one.dash.cloudflare.com) → **Networks → Tunnels → Create a tunnel** → *Cloudflared*.
2. Pojmenuj tunel (např. `penpotos`) a zkopíruj **token** (dlouhý řetězec z instalačního příkazu) do `.env` jako `CLOUDFLARE_TUNNEL_TOKEN`.
3. V záložce **Public Hostname** přidej:
   * Subdomain/Domain: `penpot.voluntia.cz`
   * Service: `HTTP` → `penpotos-core:8080`
4. Nastav `PENPOTOS_PUBLIC_URL=https://penpot.voluntia.cz` a spusť:

   ```bash
   docker compose --profile tunnel up -d
   ```

5. *(Volitelné)* Admin dashboard přes internet: přidej druhý hostname `penpot-admin.voluntia.cz` → `HTTP penpotos-core:8081` a **v Zero Trust → Access → Applications ho ochraň** (např. přihlášení e-mailem jen pro správce). Bez toho admin nevystavuj.

> Pokud je Penpot dostupný výhradně přes HTTPS, můžeš v `.env` zapnout `PENPOT_SESSION_COOKIE_FLAG=enable-secure-session-cookies`.

## 5. První kroky v adminu

1. **Výchozí nastavení** – uprav paletu barev, typografii a výchozí projekty → *Uložit*. PenpotOS vytvoří v každém týmu sdílenou knihovnu „Voluntia – Brand“.
2. **Uživatelé** – přidej členy. Heslo se zobrazí jen jednou, předej ho členovi (může si ho změnit v Penpotu).
3. **AI & MCP** – zkontroluj oprávnění AI (zápis, povolené týmy) a pošli členům návod z [claude-connector.md](claude-connector.md).
4. **Discord & model** – viz [discord-bot.md](discord-bot.md).

Týmy zakládají členové normálně v Penpotu; PenpotOS do nich do pár minut (interval v *Týmy*) přidá všechny členy a AI účet a vytvoří brand knihovnu. Tlačítko *Synchronizovat teď* to udělá hned.

## Aktualizace

```bash
cd /DATA/AppData/penpotos
git pull
docker compose pull && docker compose up -d
```

Verzi Penpotu určuje `PENPOT_VERSION` v `.env`. Při přechodu na novou verzi Penpotu aktualizuj i převzaté MCP soubory: `scripts/sync-penpot-mcp.sh <nová-verze>` (a sestav image).

## Zálohy

Všechna data jsou ve dvou Docker volumech: `penpotos_penpot_postgres_v15` (databáze včetně nastavení PenpotOS) a `penpotos_penpot_assets` (obrázky, fonty). Záloha databáze:

```bash
docker compose exec penpot-postgres pg_dump -U penpot penpot | gzip > penpot-$(date +%F).sql.gz
```

## Řešení problémů

| Problém | Řešení |
|---|---|
| `penpot-frontend` se pořád restartuje, v logu `Address family not supported by protocol` | Server nemá IPv6 → do `.env` přidej `PENPOT_IPV6_LISTEN_DIRECTIVE=#`. |
| Admin hlásí „PREPL nedostupný“ | Backend ještě startuje, nebo chybí flag `enable-prepl-server` (je v `docker-compose.yml`). |
| Penpot v prohlížeči hlásí chybu sítě | Otevíráš Penpot jinou adresou než `PENPOTOS_PUBLIC_URL`. |
| MCP: „Nepodařilo se otevřít soubor“ | `docker compose logs penpotos-mcp`; headless Chromium potřebuje RAM (`shm_size: 1gb` je nastaveno). |
