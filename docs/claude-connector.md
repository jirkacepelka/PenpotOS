# AI v Claude chatu (MCP connector)

PenpotOS má vlastní online MCP server. Na rozdíl od oficiálního Penpot MCP **nepotřebuješ mít otevřený Penpot ani plugin** – stačí chat. AI vidí všechny týmy a soubory, ke kterým jí administrátor povolil přístup, a změny se v Penpotu objevují živě.

## Připojení (člen)

Potřebuješ: účet v PenpotOS s povoleným AI přístupem (nastavuje admin) a Claude (Pro/Max/Team/Enterprise).

1. Otevři [claude.ai](https://claude.ai) → **Settings → Connectors → Add custom connector**.
2. Vyplň:
   * **Name:** `Penpot Voluntia`
   * **Remote MCP server URL:** `https://penpot.voluntia.cz/mcp` (přesnou adresu najdeš v adminu v sekci *AI & MCP*)
3. Klikni **Add** → **Connect**. Otevře se přihlašovací stránka PenpotOS – přihlas se svým Penpot e-mailem a heslem.
4. Hotovo. Connector funguje i v Claude desktopu a mobilní aplikaci (nastavení se synchronizuje).

V chatu pak stačí psát, např.:

> V Penpotu v týmu Kampaň 2026 vytvoř v projektu Sociální sítě nový soubor „Instagram – říjen“ a navrhni 3 posty 1080×1080 s heslem „Méně státu, víc svobody“. Použij barvy z brand knihovny a ukaž mi náhledy.

Claude si nejdřív přečte návod (`high_level_overview`), najde soubor, upraví ho přes Penpot Plugin API a pošle náhled (`export_shape`).

## Claude Desktop / Claude Code / jiné MCP klienty (API token)

Kde OAuth nejde použít, vygeneruje admin **API token** (Uživatelé → uživatel → *MCP přístupy* → *Vytvořit token*). Dashboard rovnou ukáže konfiguraci:

```json
{
  "mcpServers": {
    "penpot": {
      "type": "http",
      "url": "https://penpot.voluntia.cz/mcp",
      "headers": { "Authorization": "Bearer ppos_…" }
    }
  }
}
```

Claude Code: `claude mcp add --transport http penpot https://penpot.voluntia.cz/mcp --header "Authorization: Bearer ppos_…"`

## Nástroje

| Nástroj | Popis |
|---|---|
| `high_level_overview` | Návod k Penpot API (převzatý z oficiálního MCP, upravený pro práci s více soubory). |
| `penpot_api_info` | Dokumentace typů Plugin API. |
| `list_teams`, `list_projects`, `list_files`, `search_files` | Navigace v celém Penpotu. |
| `open_file` | Přehled souboru (stránky, prvky, knihovny) + odkaz do workspace. |
| `create_project`, `create_file`, `rename_file` | Zakládání (nový soubor se automaticky propojí s brand knihovnou). |
| `execute_code` | Spuštění JavaScriptu nad Plugin API (`penpot`, `penpotUtils`, `storage`) v daném souboru. |
| `export_shape` | PNG/SVG export prvku (nebo `page` = prvky stránky) – AI výsledek „vidí“. |
| `import_image` | Vložení obrázku z URL nebo base64. |

Všechny nástroje pracující s návrhem berou `fileId` (a volitelně `pageId`).

## Oprávnění a bezpečnost

* AI upravuje návrhy pod servisním účtem „Voluntia AI“; v audit logu adminu je u každého volání vidět, který člen ho spustil.
* Admin může AI úplně vypnout, přepnout do **režimu jen pro čtení** (změny se zahodí a neuloží), omezit na vybrané týmy, nebo odebrat AI přístup jednotlivým členům (tím se zruší i jejich připojení).
* Připojení (OAuth i API tokeny) lze zrušit v *AI & MCP → Aktivní MCP přístupy*.
