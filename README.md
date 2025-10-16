# FloorFlow – rezervační aplikace pro sdílená místa

FloorFlow zobrazuje interaktivní plán kanceláře a umožňuje kolegům rezervovat si sdílené pracovní místo. Backend běží na Node.js/Express, data jsou persistovaná v JSON souborech a frontend je postavený v Reactu (Vite + TypeScript).

## Jak projekt spustit

```bash
# nainstalujte závislosti serveru
npm install

# nainstalujte závislosti klienta
npm install --prefix client

# 1) spusťte API server (port 4000)
npm run dev

# 2) v dalším terminálu spusťte React aplikaci (port 5173)
npm run client

# vývoj proběhne na http://localhost:5173 (proxy <-> http://localhost:4000/api)
```

### Produkční build

```bash
# vybuildí frontend do client/dist/
npm run build

# nastartuje Express server, který obslouží API i statický build
npm start
```

## Struktura projektu

- `server/index.js` – Express API s jednoduchým úložištěm rezervací (JSON soubory)
- `server/data/seats.json` – definice všech sdílených míst (souřadnice v procentech pro vykreslení v plánku)
- `server/data/bookings.json` – aktuální rezervace (vytvoří se automaticky)
- `client/src/App.tsx` – React aplikace s interaktivním plánkem a postranním panelem
- `client/public/floorplan.png` – podkladový plán kanceláře (zatím zástupný soubor)

## Úprava plánku a míst

1. Nahraďte `client/public/floorplan.png` vaším skutečným plánkem (doporučené rozlišení cca 1600×900).
2. Spusťte aplikaci a v pravém horním rohu zvolte **Režim editace**. V editoru lze:
   - přetáhnout stávající místo a tím upravit jeho souřadnice,
   - přidat nové místo (kliknutím do plánku a vyplněním formuláře),
   - upravit popisek, zónu nebo poznámku,
   - zvětšit/zmenšit mapu pomocí posuvníku **Zoom mapy** a upravit velikost značek (pro jemné usazení na plánku),
   - případně místo odstranit.
   Změny se průběžně ukládají do `server/data/seats.json`.
3. Pokud preferujete ruční úpravy, můžete JSON soubor editovat přímo. Každý záznam obsahuje:
   - `id` / `label` – jednoznačná identifikace (např. `35-4`)
   - `x`, `y` – souřadnice v procentech (0–100) relativně k obrázku plánku
   - `zone`, `notes` – volitelné popisy

Rezervace se ukládají do `server/data/bookings.json`. Při běžném provozu není nutné soubor ručně upravovat.

## API přehled

| Metoda | Cesta                       | Popis                                                        |
|--------|----------------------------|--------------------------------------------------------------|
| GET    | `/api/seats`               | Vrátí seznam všech definovaných míst                         |
| POST   | `/api/seats`               | Vytvoří nové místo (používá editor)                          |
| PUT    | `/api/seats/:seatId`       | Aktualizuje parametry existujícího místa                     |
| DELETE | `/api/seats/:seatId`       | Smaže místo, pokud nemá aktivní rezervace                    |
| GET    | `/api/bookings?date=...`   | Vrátí rezervace pro zadané datum (`YYYY-MM-DD`)              |
| POST   | `/api/bookings`            | Vytvoří novou rezervaci `{ seatId, date, userName }`         |
| DELETE | `/api/bookings/:bookingId` | Zruší existující rezervaci                                   |

## Možné vylepšení do budoucna

- Autentizace a přístupová práva (kdo může rušit cizí rezervace).
- Napojení na firemní kalendář (Outlook/Google) nebo import z Excelu.
- Přidání týdenního / měsíčního přehledu volných míst.
- Uložení dat do skutečné databáze (např. PostgreSQL, SQLite).
- Hromadný import/export míst (CSV, Excel) a historie změn.

---

> Tip: V `.env` souboru v adresáři `client/` lze nastavit proměnnou `VITE_API_BASE_URL` pokud bude backend běžet na jiné adrese.

## Připraveno pro GitHub

- `.gitignore` ignoruje `node_modules`, build výstupy a lokální `.env`.
- `client/.env.example` slouží jako vzor pro nastavení proměnné `VITE_API_BASE_URL`.
- Výchozí `server/data/bookings.json` je prázdný – při prvním spuštění se naplní podle použití.
- Při publikování stačí:
  ```bash
  git init
  git add .
  git commit -m "Initial commit"
  git remote add origin <váš-repozitář>
  git push -u origin main
  ```

## Docker

```bash
# build image
docker build -t floorflow:latest .

# run locally (persistence volitelná)
docker run -p 4000:4000 \
  -v $(pwd)/server/data:/app/server/data \
  floorflow:latest
```

## Helm chart

V adresáři `chart/floorflow` najdete základní chart připravený pro Kubernetes.

```bash
helm install floorflow ./chart/floorflow \
  --set image.repository=<váš-registry>/floorflow \
  --set image.tag=latest

# Pokud nechcete PVC (data budou ephemeral)
helm install floorflow ./chart/floorflow --set persistence.enabled=false
```

Před instalací nahrajte výchozí místa do ConfigMapy (init-container je rozkopíruje do PVC):

Chart zároveň obsahuje ConfigMap `seats-data` se souborem `chart/floorflow/files/seats.json`. Úpravy míst zrcadlete do tohoto souboru (a případně do `server/data/seats.json` pro lokální vývoj) a znovu nasazujte přes `helm upgrade`.

### Heslo pro režim editace

Režim editace je chráněný heslem přes proměnnou `ADMIN_PASSWORD`:

- **Docker**: přidejte `-e ADMIN_PASSWORD="tajne-heslo"` do `docker run`.
- **Helm**: vytvořte Secret a předdejte ho chartu:
  ```bash
  kubectl create secret generic floorflow-admin --from-literal=password="tajne-heslo"

  helm upgrade --install floorflow ./chart/floorflow \
    --set image.repository=<váš-registry>/floorflow \
    --set image.tag=latest \
    --set admin.existingSecret=floorflow-admin
  ```

Bez nastaveného hesla je režim editace dostupný všem uživatelům.

## License

[MIT](./LICENSE)
