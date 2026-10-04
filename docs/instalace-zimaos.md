# Instalace na ZimaOS

Doporučené minimum: 4 GB RAM, 2 CPU.

## 1. Import

1. Stáhni [`zimaos/docker-compose.yml`](https://raw.githubusercontent.com/jirkacepelka/PenpotOS/main/zimaos/docker-compose.yml).
2. ZimaOS → **App Store → ⊕ → Install a customized app → Import** → vlož soubor **beze změn** → Install.

Hesla a klíče si PenpotOS při prvním startu vygeneruje sám (kontejner `penpotos-core`, volume `config`). V YAMLu se nic nevyplňuje.

## 2. První spuštění v prohlížeči

1. Otevři `http://<IP-ZimaOS>:9002`. Než Penpot založí databázi (1–3 minuty), uvidíš stránku „PenpotOS se spouští…“.
2. Vyplň formulář **Vytvoř prvního administrátora** (jméno, e-mail, heslo) a **veřejnou adresu** (doména z Cloudflare Tunnelu, nebo zatím `http://<IP-ZimaOS>:9001`).
3. Hotovo. Penpot je na portu 9001 a admin na portu 9002. Adresu jde kdykoli změnit v adminu (*Přehled → Veřejná adresa*), pak aplikaci jednou restartuj.

> Dokud admin neexistuje, může formulář vyplnit kdokoli z lokální sítě. Udělej to hned po instalaci a port 9002 nevystavuj do internetu.

### Varianta s terminálem (`docker compose` + volitelný `.env`)

```bash
git clone https://github.com/jirkacepelka/PenpotOS.git penpotos && cd penpotos
docker compose up -d        # .env není potřeba; hodnoty v něm (viz .env.example) jen přepisují výchozí
```

## 4. Přístup z internetu – Cloudflare Tunnel

MCP connector v Claude vyžaduje veřejnou HTTPS adresu. Cloudflare Tunnel ji dá bez otevírání portů na routeru.

1. V [Cloudflare Zero Trust](https://one.dash.cloudflare.com) → **Networks → Tunnels → Create a tunnel** → *Cloudflared*.
2. Pojmenuj tunel (např. `penpotos`) a zkopíruj **token**: do aplikace Cloudflared, nebo do `.env` jako `CLOUDFLARE_TUNNEL_TOKEN`.
3. V záložce **Public Hostname** přidej:
   * Subdomain/Domain: `penpot.voluntia.cz`
   * Service: `HTTP` → `penpotos-core:8080`
4. V adminu nastav veřejnou adresu `https://penpot.voluntia.cz`. Při instalaci z terminálu spusť tunel přes `docker compose --profile tunnel up -d`. Na ZimaOS stačí aplikace *Cloudflared* z App Store a hostname nasměrovaný na `http://<IP-ZimaOS>:9001`.

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

Na ZimaOS: aplikaci aktualizuj (nebo znovu importuj YAML); data a klíče ve volumech zůstanou. Verzi Penpotu určuje `PENPOT_VERSION` v `.env`. Při přechodu na novou verzi Penpotu aktualizuj i převzaté MCP soubory: `scripts/sync-penpot-mcp.sh <nová-verze>` (a sestav image).

## Zálohy

Data jsou v Docker volumech projektu `penpotos`: databáze (včetně nastavení PenpotOS), assety (obrázky, fonty) a `config` (vygenerované klíče – bez nich nejdou dešifrovat uložené API klíče). Záloha databáze:

```bash
docker compose exec penpot-postgres pg_dump -U penpot penpot | gzip > penpot-$(date +%F).sql.gz
```

## Řešení problémů

Když PenpotOS nemůže nastartovat, ukáže porty 9001 i 9002 stránku **„PenpotOS se nespustil“** s důvodem a návodem (obnovuje se sama). Stav je i na `http://<server>:9001/penpotos-status`.

| Problém | Řešení |
|---|---|
| Stránka „Heslo databáze nesedí s existující databází“ | Databázový volume pochází ze starší instalace. Aplikaci odinstaluj, smaž její volumy (`docker volume ls \| grep penpotos`) a nainstaluj znovu. Smažou se tím i data Penpotu. |
| Prohlížeč hlásí `ERR_CONNECTION_REFUSED` na portu 9001 | Kontejner `penpotos-core` neběží nebo ZimaOS přemapoval port: zkontroluj stav a porty aplikace v ZimaOS (`docker ps -a --filter name=penpot`), log `docker logs --tail 50 penpotos-core`. Verze před 4. 10. 2026 se při chybě konfigurace ukončovaly – aktualizuj image. |
| Admin hlásí „PREPL nedostupný“ | Backend ještě startuje, nebo chybí flag `enable-prepl-server` (je v `docker-compose.yml`). |
| MCP: „Nepodařilo se otevřít soubor“ | `docker compose logs penpotos-mcp`; headless Chromium potřebuje RAM (`shm_size: 1gb` je nastaveno). |
