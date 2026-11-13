> ASR policy updated in Hub0.6.3 / HUB-026: in-Hub recognition now uses the
> explicitly configured Codex LB purpose, no fallback. Ready historical transcripts
> retain their original source; MTS MCP retains upstream transcription ownership.
> See [current ASR contract](codexlb-asr.md); earlier Palatine-only notes are historical.

> HUB020 /0.6.0: актуальные cached reads, HTTP claim/ack/composer, topics и native
> default-off описаны в [Rust контракте](rust-clerk-api.md). Этот документ сохраняет
> HUB019 durable inbox/SSE основу. Ack допустим после полной durable replica
> транзакции Clerk; Markdown тогда ведёт собственный независимый checkpoint.

# Контракт самостоятельного клерка — HUB-019 / Hub 0.5.0

## Матрица и границы

| Область | Было в HUB-018 | Добавлено HUB-019 | Отдельный компонент |
|---|---|---|---|
| Получение | Фоновый выбранный history poll, backfill/gap, версии | Read-only snapshot backlog с continuation | Выбор разрешённых реальных маршрутов владельцем |
| Очередь | Независимые consumers, durable lease/replay/ack | Cursors и operational diagnostics | Идемпотентное сохранение Markdown |
| Контекст | Immutable event_get, последние 5 сообщений | Окно наблюдённых сообщений, exact reply chain, provenance | Интерпретация и распределение по задачам |
| Проекты | Scoped connections и confirmed address book | Операторские project/client/contact/exact route bindings | Каталог задач, нераспределённое, вопросы |
| Push | Не было | Локальный SSE с durable Last-Event-ID | Доставка backlog в точный Codex thread |
| ASR | Palatine подписки; остальные CodexLB/archive | Только Palatine для всех audio/video/calls, optional speakers | Авторизация МТС владельцем |

Hub не пишет Markdown, не создаёт Codex sessions/turns, не вызывает Herdr,
не отправляет вопросы клиентам и не интерпретирует сообщения как поручения.
Workzone остаётся остановлен. Доступ к inbox не даёт send authority.
Question lifecycle pending/answered/cancelled/expired, exact project/thread/question
и revision хранит клерк: в Hub такой lifecycle отсутствовал и не добавлен.

## Минимальная конфигурация и проверка привязок

Добавление к приватному конфигу Hub (не полный replacement):

```json
{
  "inbox": {
    "enabled": false,
    "push": {"enabled": false},
    "projects": [{
      "scope": "clerk-example",
      "projectId": "project-example",
      "clientId": "client-confirmed-1",
      "contactId": "confirmed-address-book-id",
      "confirmed": true,
      "label": "Внутренний пример",
      "routes": [{"connectionId": "account-example", "conversationId": "exact-chat-id"}]
    }]
  }
}
```

`projectId/clientId` — стабильные внешние ключи. `contactId`, если указан,
должен действительно владеть каждым exact endpoint в существующей адресной книге:
неподтверждённая/недоступная связь получает binding_unavailable и не участвует в
маршрутизации. Если адресной книги нет, оставьте contactId отсутствующим и
используйте отдельно подтверждённый оператором clientId. Имя не доказательство.
Несколько каналов одного человека — несколько exact routes одного clientId/contactId.
Один разговор нескольких проектов — несколько bindings; Hub возвращает ambiguous,
не выбирает проект. Изменение конфигурации меняет hash bindingRevision; старые
source identities и immutable события не меняются. Конфиг не создаёт подписок
и не расширяет grants. При отозванном route его данные не выдаются.

Read-only scope: `inbox: {read:true,manage:false,push:false}` + только нужные
`connections[].read:true,send:false,conversations:[exact IDs]`.
SSE включается оператором отдельно: и `inbox.push.enabled:true`, и
`scopes.<scope>.inbox.push:true`. Оба default-off. В установленной среде они OFF,
collector OFF, новых subscriptions/grants нет. `inbox_projects({projectId})`
компактно проверяет binding/status/revision без модели или чтения переписки.
Клерк может хранить свой маленький конфиг:

```json
{"projectId":"project-example","consumerId":"clerk-example-v1","tasksRoot":"/absolute/project/tasks","section":"Обновления от клиента","execution":{"enabled":false,"nativeThreadId":"EXACT_SAVED_THREAD_ID"}}
```

Последний конфиг принадлежит клерку, Hub его не читает/не исполняет.

## Initial sync, пакет и durable ack

Оператор с manage создаёт exact subscription (`subscription_save`, CAS revision)
и отдельный consumer (`inbox_consumer_ensure`). Полные параметры:
[durable-inbox.md](durable-inbox.md). `initialHistory:available` — доступный backfill,
`from_now` — явно выбранный пропуск старого. Consumer start=beginning или явно now.
Провайдер может иметь retention/gap; «доступная история» не означает полную переписку.

Быстро получить **весь накопленный snapshot**, не двигая ack:

```json
{"consumerId":"clerk-example-v1","after":0,"limit":50,"maxResponseChars":16000,"maxTextChars":1200}
```

Вызвать `messenger_inbox_replay`. Ответ: snapshotId, стабильный batchId страницы,
from/to/upper, items, cursor текущей страницы, nextCursor, hasMore,
readiness:raw_observed, acknowledges:false. Читать nextCursor до null; сохранять
cursor перед следующим действием. Повтор cursor возвращает ту же страницу после
рестарта. Настройки limit/budget/text фиксируются первой страницей и наследуются
continuation (новые настройки с cursor не применяются). При новом начальном
вызове возникает новый snapshot; новые arrivals вне прежнего upper.
after — явный числовой journal position, не заявление о сохранении Markdown.
Ahead/чужой/неизвестный cursor отвергается; raw replay не обходится ack.
maxResponseChars ограничивает весь MCP tool result JSON (без HTTP/JSON-RPC framing).
При большом envelope detailsOmitted содержит exact eventId для event_get, а не
молча обрезанную переписку. Длинный burst возвращается несколькими страницами.

Для применения использовать `inbox_claim` — существующий settled durable batch
с leaseToken/expiresAt. `settleMs` подписки 0..30000 (default6000) задерживает
пакет до паузы после наблюдённой активности; pending transcript не задерживает
пакет навсегда, появляется late-ready revision. Snapshot/SSE показывают raw ingest,
lease — settled prefix. Consumer сам решает когда работать, Hub не создаёт turn.

Безопасное применение клерком:

1. Получить leased batch; дочитать все detailsOmitted через event_get.
2. Разрешить только однозначные, проектные и адресованные агенту поручения.
   Факты/личное/«я проверю» — контекст; ambiguous — нераспределённое.
3. Использовать immutable sourceId/versionHash/version + eventId, а для media
   ещё fileId/mediaRevision/kind. Revision update не считать новым поручением.
4. Прочитать файл задачи и revision/hash. В одной локальной durable операции
   сохранить цитату/дату/source IDs/ссылку в разрешённую секцию и dedup receipt.
   При concurrent edit перечитать и объединить. Не переписывать задачу целиком.
5. Только после сохранения **всех** событий вызвать inbox_ack с точным batch/token.
   После сбоя проверить dedup и повторить ack. Истёкший lease получить снова.

Hub обещает at-least-once, не exactly-once внешних изменений. Его ack не означает
прочтение клиентом, delivery или выполнение задачи. Другие consumers независимы.

## Context, revisions, media

`inbox_context({consumerId,eventId,before:5,after:5,replyDepth:5,maxResponseChars:16000})`
читает cached neighbors и exact цепочку replyTo. coverage ограничено **наблюдённой**
историей; neighbors latest, immutable anchor через inbox_event_get. Неизвестный
reply/цикл/обрезка имеют replyChainComplete:false и omitted IDs.
`message_get` по умолчанию читает cache, readMode:refresh — текущий exact source у провайдера; event_get — сохранённую
версию. Эти чтения не расширяют разрешённые маршруты.
Cross-channel context: confirmed binding даёт список routes, отдельные scoped
subscriptions сохраняют их события в одном consumer. Автоматического объединения
реплик по имени или отдельного бесконтрольного account-wide поиска нет.

События содержат eventId, sequence, connection/conversation/message/sourceId,
version/versionHash/kind, sourceTimestamp, receivedAt/observedAt, автора/isSelf
(null если нет native evidence), replyEvidence/referenceKnown/quoteAvailable,
sourceUrl (null если провайдер не дал надёжную ссылку), fileId/providerVersion.
ReceivedAt — момент наблюдения Hub, не момент доставки клиенту.
Reply quote не восстанавливается угадыванием: exact cached reply отдельно в контексте.
Правки/явные tombstones — новые source revisions. Отсутствие не доказывает deletion.

Распознавание внутри Hub использует выбранный purpose media.asrProvider;
установленный Hub0.6.3 — Codex LB. См. codexlb-asr.md: timeout120000, bounded
transient retry, no redirect/model/subtitles/fallback. Готовые старые результаты
сохраняются; failed/interrupted retry явный. MTS MCP отдельно владеет текстами
звонков, Hub читает их без повторной загрузки.

Полный доступный текст и optional segments сохраняются в result/cache/event_get/
file_download. Speakers помечены speakerUncertain:true,
speakerAttribution:provider_unverified либо unavailable: это не подтверждённые
личности. Compact ответы опускают segments, полный текст запрашивается отдельно.
Обычное audio default1200s; отдельный maxCallSeconds default3600, configurable
до7200. Raw file default256MiB; **encoded upload** maxAudioBytes <=25MiB.
Большие/слишком долгие записи возвращают явную ошибку, не усечённый текст.
Автоматического chunking нет; фактическая поддержка длинных файлов/diarization
Palatine ещё требует live acceptance. Готовность/ошибка — отдельный media event,
не новая версия исходного текста. Gap требует owner/backfill review, ack его не прячет.

Отменённый вопрос: late replyTo старого messageId остаётся ordinary inbox event.
Клерк сверяет exact question revision/state; cancelled не становится answered,
не возрождается и не закрывает новый pending вопрос. Inbox grant не разрешает
отправлять вопросы; нужен отдельный send grant и явное поручение владельца.

## Локальный HTTP/SSE, reconnect и diagnostics

Все endpoints на существующем **127.0.0.1**, bearer scope обязателен,
Origin запрещён, public endpoint/callback URL нет.

```http
GET /inbox/events?consumerId=clerk-example-v1
Authorization: Bearer <PRIVATE_SCOPE_TOKEN>
Last-Event-ID: <LAST_RECEIVED_OPAQUE_ID>
Accept: text/event-stream
```

Фрейм: `id: UUID`, `event: inbox_observed`, `data:{eventId,sequence,consumerId,
readiness:"raw_observed",requiresClaim:true}`. Ни body, ни токен в URL.
Рекомендуется fetch/HTTP client с headers, а не браузерный EventSource.
Первый connect от текущего ack, reconnect от последнего **полученного** ID.
Сохранять ID durable; это wakeup, не признание обработки. Дубли допустимы.
Raw initial replay может быть длинным; frames компактные. Socket backpressure
останавливает запись; на disconnect данные остаются в журнале. После shutdown
соединения закрываются, затем клиент reconnect/replay. Push использует локальную
publication после commit в одном Hub service process, не скрытый provider polling.
Другой процесс с тем же SQLite не будит этот EventEmitter; reconnect/replay
читает durable журнал. Multi-process push topology не реализована. Настройка worker отдельно.
SSE при отзыве scope/route закрывается при следующем событии/проверке; без новой
активности сокет может оставаться открытым, но приватных body в нём нет.
Resume tokens и snapshots durable, без автоматического удаления; следить за private
SQLite размером. Heartbeats нет: внешний supervisor выполняет reconnect после
своего socket timeout. Полнота данных доказуется journal replay/claim, не сокетом.

Обычный read-only API (тот же результат, без MCP envelope):

```http
POST /inbox/read
Authorization: Bearer <PRIVATE_SCOPE_TOKEN>
Content-Type: application/json

{"method":"inbox_replay","input":{"consumerId":"clerk-example-v1","maxResponseChars":16000}}
```

Allowlist: inbox_projects/replay/context/diagnostics/event_get, subscription_status.
Manage/claim/ack доступны также через scoped /api/v1/call; маленькая программа использует штатный
MCP SDK с тем же scoped credential. Нет разрешения произвольного Hub.call.
Для HTTP/публичного MCP ошибки имеют safe code/stage/correlationId/retryable.
inbox_cursor_invalid → восстановить сохранённый cursor точного consumer или явно
replay от известной позиции; никогда не считать чужую позицию обработанной.
inbox_response_budget_too_small → увеличить бюджет, ack не двигался.

`inbox_diagnostics({consumerId})`: observed/acked cursor, exact pending count,
oldestPendingReceivedAt/lagMs, leasedEvents/lease expiry, subscription syncAgeMs,
lastSuccessAt/provider status, gap/backfill, media statuses, worker/push config.
Failed external batches принадлежат клерку; Hub не выдаёт их за свою обработку.
`connections.inbox` показывает runtime collector/push grant/Palatine;
`schema/health` показывают version/build/source/schema hash. CLI:

```sh
MESSENGER_HUB_CREDENTIAL=/private/path/clerk.json node scripts/inbox-smoke.mjs
# optional MESSENGER_HUB_CONSUMER=clerk-example-v1
```

Credential file `{url:"http://127.0.0.1:8792/mcp",token:"..."}`, mode600.
Smoke проверяет опубликованный каталог/schema, config/status, optional consumer
positions. Не вызывает модели/provider history, не создаёт consumer/lease/ack,
не включает collector и не печатает переписку.

## Handoff в Codex App Server — описание, не код Hub

Контракт следующего компонента: точный nativeThreadId, один execution owner,
durable backlog delivery intent/receipt/reconciliation. Собирать все накопленные
обновления проекта одним пакетом. Active → ждать/копить; waitingOnUserInput или
waitingOnApproval → не продолжать и не отвечать за владельца; idle без blockers →
доставка только явно включённой policy. notLoaded → восстановить точную сохранённую
сессию, не создавать дубликат по title/cwd. Потерянный ответ → reconciliation,
не слепое повторение turn/start. Не удалять locks и не restart shared daemon.

Сведения владельца: daemon/CLI0.159.2, read-only WebSocket HTTP Upgrade к текущему
control Unix socket уже проверен; thread/list/read/loaded/list, status/changed,
turn/start/steer/completed, thread/queue и codex queue доступны. Эта задача не
перепроверяет/не запускает daemon и не повторяет MCP2 webhook experiment.
CLI transport/совместная реакция живой CLI и App Server ещё отдельный live gate.
Публичный протокол описан в [официальной документации App Server](https://learn.chatgpt.com/docs/app-server).
Пробуждение Codex и question state — отдельные компоненты, в Hub их нет.

## Проверка и публикация

## Addendum HUB021 /0.6.1

[Inbox provenance1 / immutable cutover / author labels](inbox-provenance.md).
from_now retains all journal events; historical filtering belongs to Clerk. Legacy
missing evidence is unknown/review, late media inherits source affiliation.
