# Discord bot

Bot čte zprávy v nastavených kanálech, ke každému úkolu založí vlákno, průběžně ukazuje, co dělá (*hledám soubory → upravuji návrh → exportuji náhled*), a nakonec pošle odpověď s náhledy a odkazem do Penpotu. Na odpověď lze ve vlákně navázat („udělej text větší“) – bot si pamatuje kontext.

## 1. Vytvoření bota v Discordu

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** (např. „Voluntia Design AI“).
2. **Bot** → *Reset Token* → zkopíruj token.
3. Tamtéž zapni **Privileged Gateway Intents → Message Content Intent**.
4. **OAuth2 → URL Generator**: scopes `bot`; permissions *View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Attach Files, Read Message History*. Otevři vygenerovanou URL a přidej bota na server.
5. V Discordu zapni *Nastavení → Pokročilé → Režim vývojáře* a pravým klikem zkopíruj **ID kanálu** (případně ID rolí, které smí zadávat úkoly).

## 2. Nastavení v admin dashboardu

*Discord & model*:

* **Bot token**, **ID kanálů** (oddělené čárkou), volitelně **ID rolí**.
* **Systémový prompt** – jak se má AI chovat (výchozí: česky, drží se brand knihovny, vrací odkaz a náhled).
* Zaškrtni *Bot zapnutý* → uložit. Bot se připojí do ~10 s, stav uvidíš na stránce.

## 3. Výběr AI modelu

| Poskytovatel | Kdy | Poznámka |
|---|---|---|
| **Anthropic API** (doporučeno) | Klíč z [console.anthropic.com](https://console.anthropic.com), platí se za použití. | Výchozí model Claude Opus 5.5; levnější Claude Sonnet 5.5. Automatický fallback při odmítnutí požadavku. |
| **Claude předplatné** | Máš Claude Pro/Max a chceš ho využít. Na serveru spusť `claude setup-token` (nebo lokálně) a token vlož do adminu. | Běží přes Claude Agent SDK. ⚠️ Podmínky Anthropicu nepovolují zpřístupňovat přihlášení/limity předplatného dalším lidem přes vlastní produkty – bot, kterého používá více členů, je na hraně. Pro sdíleného bota použij API klíč. |
| **OpenAI-kompatibilní** | OpenRouter, Ollama, OpenAI, … | Zadej Base URL, model a klíč. Kvalita závisí na modelu (potřebuje tool calling a vidění). |

> Členové, kteří AI používají přímo v Claude chatu přes connector ([claude-connector.md](claude-connector.md)), čerpají ze svého vlastního předplatného – to je s podmínkami v pořádku a bot k tomu nepotřebují.

## 4. Použití

V nastaveném kanálu napiš úkol, případně přilož obrázky (logo, fotku):

> Udělej banner na Facebook 1200×630 na akci „Den svobody 15. 11.“ v souboru Kampaň → Sociální sítě → Facebook. Fotku z přílohy dej doleva.

* Přiložené obrázky AI vidí a umí je vložit do návrhu (`import_image`).
* V jiných kanálech reaguje bot na @zmínku (lze vypnout).
* Všechny úkoly jsou v *Audit log* (zdroj Discord).
