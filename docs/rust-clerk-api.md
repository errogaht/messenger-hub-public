> ASR policy updated in Hub0.6.3 / HUB-026: in-Hub recognition now uses the
> explicitly configured Codex LB purpose, no fallback. Ready historical transcripts
> retain their original source; MTS MCP retains upstream transcription ownership.
> See [current ASR contract](codexlb-asr.md); earlier Palatine-only notes are historical.

# Rust Clerk — Hub 0.6.0, HTTP/read contract 1

Hub владеет source/cache/media и scoped transport. Clerk владеет workspace,
roots, Markdown, triage, вопросами и Codex delivery. Workzone выключен.
Wire MCP contract 2, plugin contract 1 сохранены. Новых моделей для доставки нет.

## Матрица

| Область | Уже было HUB018/019 | HUB020 | Отдельный компонент / ограничение |
|---|---|---|---|
| Durable inbox | Independent consumer, replay/lease/ack/revisions/gaps/SSE | Native raw commit в тот же журнал | Локальная replica/triage Clerk |
| Read | Exact provider history/message, immutable event/context | Default cached history/message/search/catalog, message_context, explicit refresh | Оператор выбирает реальные каналы |
| Каталог | Scoped connections/conversations | Cached pagination/search, Telegram exact topics | Topic — фильтр внутри chat grant, не отдельная ACL |
| Transport | History polling | Existing Telethon update handlers; GOWA HMAC webhook | Оба default-off, live native не принят |
| Composer | Durable exact text/media/requestId/receipts | Версионированный local HTTP, exact topic root | Email SMTP отсутствует; МТС read-only |
| Email | Imported snapshots | Read-only RFC822 export adapter | IMAP/SMTP/account auth не реализованы |
| ASR | Palatine, late media events | Сохранено; cached reads без ASR | Новая live ASR этой задачей не проверяется |

## Local HTTP и опубликованная схема

Только существующий `http://127.0.0.1:8792`, Bearer scoped credential.
Origin запрещён. Секретный файл mode600; токен не в URL, логах или JSON примеров.
`GET /api/v1/schema` возвращает версии/build/schema и **доступный этому scope**
MCP catalog. `POST /api/v1/call` принимает:

```json
{"method":"history","input":{"connectionId":"account-example","conversationId":"exact-chat-id","mode":"compact","limit":50,"maxResponseChars":16000}}
```

Ответ: `{"httpContractVersion":1,"result":{...}}`. MCP вызывает
`messenger_history` с тем же input и возвращает тот же result.
Ошибка содержит safe code/stage/correlationId/retryable; receipt не delivery/read.
Allowlist HTTP: connections/conversations/topics/history/message_get/message_context/
search_messages/schema, subscription_status/save, inbox_projects/consumer_ensure/
replay/claim/ack/context/event_get/diagnostics, file_download/files_download,
transcription_status/transcribe_media, media_stage/send_raw/send_media/delivery/
media_delivery. Авторизация каждого метода сохраняется; allowlist не выдаёт grant.
Contact rewrite/модель, arbitrary Hub calls, Herdr и запуск Codex здесь отсутствуют.

Минимальный Rust вызов (reqwest/serde_json):

```rust
let response = reqwest::Client::new()
    .post("http://127.0.0.1:8792/api/v1/call")
    .bearer_auth(private_token)
    .json(&serde_json::json!({"method":"history","input":{
        "connectionId":connection_id,"conversationId":conversation_id,
        "mode":"compact","maxResponseChars":16000
    }}))
    .send().await?.error_for_status()?.json::<serde_json::Value>().await?;
// Persist source identities/revisions locally; do not interpret HTTP 200 as send confirmation.
```

Не принимать произвольный base URL из сообщения клиента. Доверенные settings
и scoped token принадлежат локальному оператору. UI не должен получать collector token.

## Cache-first / initial sync / context

Default `readMode:"cached"` у history/message_get/search_messages/conversations/topics.
Cache miss НЕ вызывает provider. История может вернуть пустой observed subset;
message_get — `message_not_cached` с инструкцией explicit refresh.
Для initial sync оператор/Clerk явно вызывает history с `readMode:"refresh"`,
продолжает каждый `next` до конца разрешённого provider window, затем использует
cached reads. Старые provider cursors и новые cached cursors не взаимозаменяемы.
`cache.defaultRead` существует для совместимости; production default cached.

```json
{"method":"history","input":{"connectionId":"account-example","conversationId":"exact-chat-id","readMode":"refresh","limit":100,"mode":"compact","maxResponseChars":16000}}
```

Compact сокращает только представление, с явными флагами. `maxResponseChars`
ограничивает сериализованный history response; continuation сохраняет остаток.
Cached pagination фиксирует exact revisions: новые arrival/edit не переставляют
страницы. Cursors scoped и привязаны к параметрам запроса, durable после restart.
Существующие hp: response snapshots имеют явный TTL24h; cc: cache handles не
удаляются автоматически. Истечение страницы не удаляет полный source/journal.
Полный `message_get` не сокращает сохранённый текст; большой full response
нужно принимать потоково/с достаточным локальным лимитом.

`cache`: source/providerContacted, lastObservedAt/ageMs/stale,
Coverage topic-specific: полный General не доказывает полноту всего чата.
coverage `observed_subset` либо `provider_reported_complete_at_refresh`,
completeRefreshAt, gap, transportModes, retention. Exhausted cache не означает
полную историю провайдера. Время наблюдения не подтверждает отсутствие новых
входящих. Новые cache tables не заполняются ретроспективно из старого provider cache:
нужен explicit refresh либо будущий выбранный ingest.

`message_context({connectionId,conversationId,messageId,before:5,after:5,
maxResponseChars:16000})` — быстрое compact окно только cached neighbors,
omitted IDs/coverage явны. Exact reply chains immutable событий остаются в
`inbox_context` / `inbox_event_get`. Full source — message_get.
`search_messages` cached ищет observed Unicode text плюс отдельно cached audio;
`readMode:refresh` сохраняет provider-specific search coverage. Contacts и
wait_for_settled_message сохраняют явный provider discovery/polling — это не cache UI API.

Каталог: connections без provider I/O; conversations/topics cached, query/limit/cursor;
explicit refresh отдельно. Нельзя объединять клиентов по title/username.
Telegram topicId — native root ID внутри exact conversationId. Топики проверяются
через существующий bridge; topic history — GetReplies exact root, до100/page.
Topic message refresh ограничен2000 сообщениями, дальше явная ошибка, без угадывания.

Retention: автоматического удаления journals, unacked, full texts, cache versions,
page handles и native receipts нет. Следить за private disk growth. Это безопасная
первая политика, не обещание ограниченного использования диска.

## Durable Clerk и UI raw arrival

Используйте существующие HUB019 consumer/subscription/project bindings из
[clerk-api](clerk-api.md), не создавайте второй журнал. Один workspace может
содержать несколько confirmed routes/roots. Неоднозначные project bindings
возвращаются как ambiguous; Hub не выбирает задачу.

UI читает inbox_replay/SSE **сразу после raw commit**, не ждёт triage.
settleMs подписки default6000 применяется только inbox_claim;
можно настроить0..30000 отдельно от ingest. History poll default10s остаётся
явно history_poll, не называется native. Для native updates внешней доставки
не требуется provider poll на каждый вопрос агента.

Клерк может ack после транзакционной записи **всех** событий leased batch в свою
локальную durable replica и dedup receipts. Markdown triage тогда имеет собственный
checkpoint/retry. Если такой replica нет, ack только после durable Markdown.
Не ack неполный snapshot. Lease/ack не доказывает исполнение задач; внешний эффект
at-least-once, идемпотентность по sourceId/revision/eventId обеспечивает Clerk.
После restart: восстановить consumer/cursor, lease/replay, применить dedup,
ack exact batch/token. Gap требует explicit backfill review, не скрывается ack.
Late transcript/media — отдельное событие/revision после raw сообщения; полный
текст доступен event_get/file_download. Внутри Hub выбран Codex LB; MTS MCP отдельно владеет текстом,
записями и metadata. Speakers uncertain, transcript truncation явна только в compact.

SSE остаётся `/inbox/events?consumerId=...`, Bearer header, Last-Event-ID durable.
Это wakeup/replay, не ack. Reconnect после socket timeout, journal сохраняется;
multi-process native publication не реализована. См. HUB019 контракт ограничений.

## Native, выбранные scopes и recovery

Telegram helper `bridges/telegram-hub-updates.py` подключён узким lifecycle hook
к **существующему** telegram-mcp runner. Borrowed client, никакого нового login,
копии session или legacy MCP подключения к Codex. Обработчики NewMessage/Edit/Delete
включаются только `MESSENGER_HUB_INGEST_CONFIG` private600 с enabled:true,
account/expectedSelfId/exact chatIds, credentialFile/store. Сверка get_me
до регистрации; mismatch блокирует. Durable outbox до Hub I/O, retry того же
providerEventId после потери ответа; private cached sources для deletions.
Peerless deletion не маршрутизируется по предположению. Telegram disconnect gaps
нельзя считать закрытыми только за счёт outbox: нужен scoped explicit backfill.

Hub config дополнение (выключено по умолчанию):

```json
{"native":{"enabled":false,"bindings":[{
  "connectionId":"account-example","scope":"collector-example",
  "transport":"telegram_native","subscriberScopes":["clerk-example"]
}]}}
```

Collector scope должен иметь inbox.read/nativeIngest и exact route read grants.
SubscriberScopes — явный список readonly получателей; только enabled selected
subscriptions с их **текущими** grants получают события. Clerk не получает
nativeIngest/send автоматически. POST `/api/v1/ingest/<connectionId>` с collector
Bearer принимает providerEventId/accountSelfId/message; транзакция cache+journal+
receipt, повтор одинакового payload безопасен, ID с другим payload conflict.
Нет выбранной subscription — native_route_unselected, body не сохраняется.

GOWA `/api/v1/webhook/<connectionId>`: fixed binding, private HMAC secret600,
X-Hub-Signature-256 sha256(raw body), mandatory exact deviceId, выбранные scopes/chats.
Поддержаны message/edit/delete/revoke из [официального v9.1.0 payload](https://github.com/aldinokemal/go-whatsapp-web-multidevice/blob/v9.1.0/docs/webhook-payload.md).
Unsupported events ignored; acknowledgments не recipient delivery/read.
Native media metadata best-effort, full authoritative metadata через refresh/download.
Webhook sender должен обеспечивать retry/durable delivery; Hub не доказывает
непотерянную доставку всего GOWA потока без scoped recovery.
**Существующий GOWA webhook в Workzone не перенаправлен**; включение нового маршрута
требует отдельного согласованного решения, не расширения Hub grant.

connections.sourceCapabilities.ingestion: configured/mode/lastReceiptAt/
commitLatencyMs/sourceTimestampAgeMs. `_awaiting_receipt` означает лишь настройку,
не доказанный активный поток. Commit latency измеряет Hub transaction, source age
зависит от часов; не end-to-end UI latency. Native real acceptance не выполнена.

## Composer и media

Exact `send_raw` plain text/emoji без модели; route connectionId/conversationId,
optional topicId, replyTo, стабильный requestId. Rich formats — по capabilities.
Stage локального файла через media_stage в разрешённом uploadRoot, затем
send_media c fileId/type/caption/replyTo/requestId. Форматы/входы берите из schema.
Пример exact route composer (схема проверяется сервером, это не test send):

```json
{"method":"send_raw","input":{"connectionId":"account-example","conversationId":"exact-chat-id","text":"Готово 🙂","requestId":"clerk-message-stable-001"}}
```

```json
{"method":"media_stage","input":{"connectionId":"account-example","conversationId":"exact-chat-id","localPath":"/private/allowed-upload-root/fixture.png","type":"image"}}
```

```json
{"method":"send_media","input":{"connectionId":"account-example","conversationId":"exact-chat-id","fileId":"<UUID_FROM_STAGE>","type":"image","caption":"Скриншот","requestId":"clerk-media-stable-001"}}
```

После media_stage использовать его fileId; localPath должен находиться в uploadRoot.
Ответ unknown → delivery/media_delivery того же requestId, reconcile история/receipt;
не генерировать новый requestId ради повтора. confirmed sent — provider submission,
recipient delivery/read остаются unknown. Failed preparation — не отправка.

Telegram topic composer подтверждает root и отправляет в него. Quoted reply к
произвольному другому messageId внутри topic пока blocked
`topic_reply_verification_unsupported`: нет доказательства принадлежности root.
Без topic обычные existing replies/media сохранены. Bitrix медиа unsupported;
МТС и email composer unavailable. Email — только локальные .eml exports, без SMTP.

file_download/files_download повторно используют cached bytes, URL требует Bearer,
SHA256/MIME/оригинальное имя сохраняются. Metadata-only read не скачивает файл/не
запускает ASR. Недоступный original — safe error/retryable/action; cached originals
остаются доступны по текущим grants даже при offline provider. No fallback ASR.
Email export helper Python3 stdlib: private operator mailbox roots, no symlink escape,
max25MiB .eml, MIME/attachments, HTML source помечен и не исполняется. Identity
SHA256 filename внутри mailbox; переименование export меняет ID. Изменённый .eml
не выдаёт другие bytes под прежним attachment identity. IMAP IDLE/SMTP отсутствуют.

## Smoke / acceptance

```sh
MESSENGER_HUB_CREDENTIAL=/private/path/clerk.json node scripts/inbox-smoke.mjs
node scripts/cache-benchmark.mjs
python3 -m unittest discover -s test -p telegram_native_bridge_test.py
npm test
```

## Addendum HUB021 /0.6.1

[Inbox provenance1 / immutable cutover / author labels](inbox-provenance.md).
from_now retains all journal events; historical filtering belongs to Clerk. Legacy
missing evidence is unknown/review, late media inherits source affiliation.

## Addendum HUB022 /0.6.2

[Native Telegram mentionEvidence1 / verified identity / scoped reader setup](telegram-mentions.md).
New identity MCP/HTTP method, health HTTP allowlist. Exact private selected activation
can enable native/SSE without all-account polling or send; no natural receipt means no latency claim.
