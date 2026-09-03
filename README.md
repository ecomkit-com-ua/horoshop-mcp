# horoshop-mcp

**English:** an MCP server for the [Horoshop](https://horoshop.ua) e-commerce platform. It gives
Claude, Cursor and any other MCP client direct access to a Horoshop store's API — orders,
catalog, categories, customers, product sets, reference data and webhooks. Install with
`npx -y horoshop-mcp`, configure with your store domain and an admin
login. `llms-install.md` lets an AI agent do the whole setup for you. MIT licensed.
Documentation below is in Ukrainian.

---

> Пояснення для власника магазину, без технічних деталей —
> [ecomkit.com.ua/instrumenty](https://ecomkit.com.ua/instrumenty/?utm_source=github&utm_medium=readme&utm_campaign=horoshop-mcp).

## Що це

Це MCP-сервер для [Horoshop](https://horoshop.ua). Він дає Claude (або будь-якому іншому
MCP-клієнту) прямий доступ до API вашого магазину: замовлення, каталог, розділи, покупці,
комплекти товарів, довідники доставки й оплати, вебхуки.

Далі можна просто просити звичайною мовою:

- «покажи замовлення за минулий тиждень, які ще в обробці»
- «вивантаж товари з розділу "Аксесуари", де не заповнений SEO-опис»
- «онови ціни на ці 20 артикулів»
- «скільки покупців зареєструвалося в серпні»

Сервер не має власної логіки поверх Horoshop — це тонка обгортка над
[офіційним API](https://horoshop.notion.site/api-doc).

## Що потрібно

- Node.js 20 або новіший
- магазин на Horoshop
- логін і пароль адміністратора

## Встановлення через ШІ

Найшвидший шлях — попросити про це самого асистента. Скопіюйте цей промпт у Claude Code,
Claude Desktop або Cursor:

```
Встанови мені MCP-сервер horoshop-mcp.
Інструкція для тебе:
https://github.com/ecomkit-com-ua/horoshop-mcp/blob/main/llms-install.md
Прочитай її й виконай: спитай у мене домен магазину, логін і пароль адміна, пропиши конфіг
для того клієнта, у якому ти зараз працюєш, залиш на перший раз режим лише-читання
і перевір, що сервер відповідає.
```

Асистент сам спитає доступи, впише блок у потрібний файл конфігурації й перевірить зв'язок.
Пароль він записує тільки в конфіг — не в чат і не в git.

Далі — те саме руками, якщо так зручніше.

## Крок 1. Створіть окремого адміна для API

В адмінпанелі магазину: **Налаштування → Адміни → додати адміністратора**.

Створіть **окремий** обліковий запис саме для API, а не використовуйте свій особистий. Так
доступ можна відкликати одним рухом, не блокуючи собі вхід, і в логах видно, що саме робив
інтеграційний доступ.

Horoshop не має API-ключів: авторизація йде звичайним логіном і паролем адміна.

## Крок 2. Підключіть сервер

**Claude Code** — у `.mcp.json` в корені проєкту:

```json
{
  "mcpServers": {
    "horoshop": {
      "command": "npx",
      "args": ["-y", "horoshop-mcp"],
      "env": {
        "HOROSHOP_DOMAIN": "myshop.com.ua",
        "HOROSHOP_LOGIN": "api",
        "HOROSHOP_PASSWORD": "..."
      }
    }
  }
}
```

**Claude Desktop** — те саме, але у `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`).

**Cursor** — той самий блок у `~/.cursor/mcp.json`.

**Cline** — той самий блок у `cline_mcp_settings.json`.

**Gemini CLI** — той самий блок у `~/.gemini/settings.json`.

**VS Code (GitHub Copilot)** — те саме у `.vscode/mcp.json`, але сервери лежать
під ключем `servers`, а не `mcpServers`.

Будь-який інший клієнт із підтримкою MCP через stdio теж підійде — конфіг скрізь той самий.

Після цього перезапустіть клієнт.

`npx` сам завантажить пакет з npm — окремо нічого встановлювати не треба. Найсвіжіший код,
ще до релізу, ставиться прямо з GitHub: `["-y", "github:ecomkit-com-ua/horoshop-mcp"]`.

> Файл конфігурації містить пароль адміна відкритим текстом. Тримайте його поза git —
> додайте `.mcp.json` у `.gitignore`.

## Інструменти

Читання:

- `horoshop_orders_list` — замовлення з товарами, доставкою, оплатою, знижками й UTM-мітками.
  Фільтри за датами, номерами та статусами
- `horoshop_order_statuses` — усі статуси замовлень магазину (потрібен Horoshop 4.0+)
- `horoshop_products_export` — товари з каталогу: ціни, наявність, розділи, характеристики,
  залишки, SEO. Фільтри за розділом, артикулом і видимістю
- `horoshop_categories_export` — дерево розділів каталогу з ідентифікаторами
- `horoshop_users_export` — зареєстровані покупці
- `horoshop_store_reference` — довідники магазину одним інструментом: варіанти й типи доставки,
  варіанти й методи оплати, валюти з курсами, іконки товарів, а для B2B — групи покупців і
  рівні цін

Запис:

- `horoshop_products_import` — створення й оновлення товарів
- `horoshop_orders_update` — статус, ознака оплати, номер відстеження
- `horoshop_users_import` — створення й оновлення покупців
- `horoshop_product_sets_import` / `horoshop_product_sets_remove` — комплекти «разом дешевше»
- `horoshop_webhook_subscribe` / `horoshop_webhook_unsubscribe` — підписка на події магазину

Універсальний виклик:

- `horoshop_call` — будь-яка функція API за назвою з документації. Для того, чого ще немає
  серед окремих інструментів

## Обережно з імпортом товарів

`horoshop_products_import` пише в живий магазин, і **скасувати це неможливо**. Найнебезпечніші
значення за замовчуванням:

- `images`, `gallery_common` і `gallery_360` мають `override: true` за замовчуванням — це
  **видаляє поточну галерею** перед завантаженням нових фото. Щоб додати фото без видалення,
  передавайте `override: false`; щоб не чіпати галерею — не передавайте її взагалі
- `accessories` і `gifts` **замінюють** поточні списки, а не доповнюють їх

Перед масовим імпортом перевірте все на одному тестовому артикулі й звірте результат через
`horoshop_products_export`.

Якщо потрібен доступ лише на читання — поставте `HOROSHOP_READONLY=1`, і інструменти запису
взагалі не з'являться в списку.

## Змінні середовища

Обов'язкові:

- `HOROSHOP_DOMAIN` — домен магазину, наприклад `myshop.com.ua`. Можна з `https://`, можна без
- `HOROSHOP_LOGIN` — логін адміна
- `HOROSHOP_PASSWORD` — пароль адміна

Необов'язкові:

- `HOROSHOP_READONLY=1` — сховати всі інструменти запису
- `HOROSHOP_TIMEOUT_MS` — таймаут запиту, за замовчуванням `60000`
- `HOROSHOP_MAX_RESPONSE_BYTES` — межа розміру відповіді, за замовчуванням `100000`. Великі
  вивантаження обрізаються з поміткою, скільки записів показано — див. «Гортання великих
  вивантажень»
- `HOROSHOP_INSECURE_HTTP=1` — звертатися по `http` замість `https` (для тестових магазинів)

## Гортання великих вивантажень

`horoshop_orders_list`, `horoshop_products_export` і `horoshop_users_export` приймають `limit`
і `offset`. Але розмір відповіді обмежений ще й окремо — через `HOROSHOP_MAX_RESPONSE_BYTES`.

Ці два обмеження незалежні, і це важливо. Horoshop може віддати всі 50 запитаних товарів, а в
бюджет відповіді влізе, скажімо, 17. Решта 33 вже приїхали, але показані не будуть.

Тому підказка про наступну сторінку рахується **від показаних записів, а не від `limit`**: після
такої обрізаної сторінки сервер каже продовжити з `offset 17`, а не з `offset 50`. Якби він
радив `offset 50`, ті 33 товари зникли б назавжди — жоден наступний запит їх би не зачепив.

Що з цього варто знати:

- обрізана сторінка завжди залишається валідним JSON — записи прибираються з кінця масиву цілими,
  сервер не ріже відповідь посередині запису
- якщо в бюджет не влазить навіть один запис, сервер каже про це прямо: гортання тут не допоможе,
  потрібно просити менше полів (`include_params`) або підняти `HOROSHOP_MAX_RESPONSE_BYTES`
- якщо Horoshop віддав менше, ніж запитано, сервер позначає це як останню сторінку й не пропонує
  наступний `offset`

## Обмеження Horoshop, про які варто знати

- токен авторизації живе 600 секунд — сервер оновлює його сам
- `catalog/export` віддає максимум 500 товарів за раз; гортайте через `offset`
- `orders/get` і `users/export` ігнорують `offset` без `limit` — сервер завжди надсилає обидва
- вебхуків на одну подію може бути не більше 5, і API не вміє показати наявні підписки
- частина функцій потребує Horoshop 4.0+ або модуля B2B — тоді у відповіді буде
  `UNDEFINED_FUNCTION`

## Розробка

```bash
npm install
npm run build
node dist/index.js
```

### Тести

```bash
npm test
```

`npm test` спочатку виконує `npm run build`, тож тести завжди йдуть проти скомпільованого
`dist/`, а не проти джерел. Справжній магазин для цього не потрібен: макет Horoshop піднімається
на випадковому порту `127.0.0.1`, тому тести не роблять жодного зовнішнього запиту.

Що де лежить:

- `test/format.test.mjs` — юніт-тести форматера відповіді: обрізання великих payload'ів,
  підказки про наступну сторінку, статуси `EMPTY` і `WARNING`, перетворення помилок
- `test/server.test.mjs` — інтеграційні тести. Піднімають справжній `dist/index.js` окремим
  процесом і спілкуються з ним по JSON-RPC через stdio, як це робить MCP-клієнт: рукостискання,
  список інструментів, режим лише-читання, життєвий цикл токена, форми відповідей Horoshop
- `test/support/mock-horoshop.mjs` — макет API: авторизація, протермінований токен, конверти
  відповідей, неконвертовані `hooks/*`, HTML замість JSON
- `test/support/mcp-client.mjs` — мінімальний MCP-клієнт для тестів

Один файл окремо:

```bash
node --test test/format.test.mjs
```

Новий файл тестів достатньо назвати `test/<щось>.test.mjs` — `npm test` підхопить його сам.
Файли в `test/support/` тестами не вважаються, це допоміжний код.

## Ліцензія

MIT.

## Privacy Policy

**No data is collected.** This server contains no telemetry, analytics or usage reporting,
and makes no requests to any server operated by ecomkit.

- **Credentials** — your store domain, admin login and password are stored in your own MCP
  client's configuration file on your own machine and are transmitted only to your own store.
  The author has no access to them.
- **Where your data does go** — the server passes your store's data into your conversation
  with your AI assistant, so it reaches your AI provider (Anthropic, Google, OpenAI or
  another) under that provider's privacy policy, not this one. Do not request exports of data
  that must not leave your company.
- **Third parties** — none beyond those two. Nothing is shared, sold or transferred.
- **Retention** — none by the author, as nothing is received.
- **Contact** — hello@ecomkit.com.ua

Full policy, in Ukrainian and English:
[ecomkit.com.ua/pryvatnist-instrumenty](https://ecomkit.com.ua/pryvatnist-instrumenty/)

---

Зробив [Сергій Троїцький](https://ecomkit.com.ua) — запуск, SEO та автоматизація інтернет-магазинів.
Потрібен аудит магазину на Horoshop?
[ecomkit.com.ua](https://ecomkit.com.ua/instrumenty/?utm_source=github&utm_medium=readme&utm_campaign=horoshop-mcp)
